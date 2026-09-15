(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const fmt = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });
  const PAGE_SIZE = 14;
  const palette = { raw: "#687994", smooth: "#5ee6c4", reference: "#7da2ff", vibration: "#ffbd68", pressure: "#7da2ff" };
  const state = { data: null, hours: 24, smooth: 15, hidden: new Set(), page: 1, search: "", tempView: null };

  function toast(message) {
    const el = $("#toast"); el.textContent = message; el.classList.add("show");
    clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 2800);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
  }

  function parseTime(value) {
    if (value instanceof Date) return value;
    if (typeof value === "number" && value > 25000) return new Date((value - 25569) * 86400000);
    const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date;
  }

  function mapColumns(headers) {
    const find = (...terms) => headers.findIndex((header) => terms.some((term) => String(header).toLowerCase().includes(term)));
    const mapped = {
      time: find("측정시각", "timestamp", "datetime", "date", "시간"),
      elapsed: find("경과시간(시간)", "elapsed hour"),
      tempRaw: find("원시값", "raw temp", "temperature", "온도"),
      tempRef: find("참값", "reference", "target"),
      vibration: find("진동", "vibration", "rms"),
      pressure: find("압력", "pressure", "kpa"),
      event: find("이벤트", "event", "상태", "status")
    };
    if (mapped.tempRaw < 0) {
      mapped.tempRaw = headers.findIndex((_, index) => index !== mapped.time);
    }
    return mapped;
  }

  function prepareData(payload) {
    const headers = payload.headers.map((header, index) => header || `열 ${index + 1}`);
    const columns = mapColumns(headers);
    const rows = payload.rows.map((row, index) => {
      const time = columns.time >= 0 ? parseTime(row[columns.time]) : new Date(Date.now() + index * 60000);
      const numeric = (column) => column >= 0 && row[column] !== "" && row[column] != null && Number.isFinite(Number(row[column])) ? Number(row[column]) : null;
      return { source: row, time, raw: numeric(columns.tempRaw), reference: numeric(columns.tempRef), vibration: numeric(columns.vibration), pressure: numeric(columns.pressure), event: columns.event >= 0 ? String(row[columns.event] ?? "미분류") : "미분류" };
    }).filter((row) => row.raw !== null || row.vibration !== null || row.pressure !== null);
    if (rows.length < 2) throw new Error("분석할 수 있는 숫자 데이터가 충분하지 않습니다.");
    return { ...payload, headers, columns, rows };
  }

  function visibleRows() {
    const rows = state.data.rows;
    if (state.hours >= 24 || !rows.some((row) => row.time)) return rows;
    const end = rows[rows.length - 1].time?.getTime();
    if (!end) return rows;
    const start = end - state.hours * 3600000;
    return rows.filter((row) => !row.time || row.time.getTime() >= start);
  }

  const values = (rows, key) => rows.map((row) => row[key]).filter(Number.isFinite);
  const mean = (array) => array.length ? array.reduce((sum, value) => sum + value, 0) / array.length : 0;
  const std = (array) => { const m = mean(array); return Math.sqrt(mean(array.map((value) => (value - m) ** 2))); };
  const median = (array) => { const sorted = [...array].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
  const correlation = (a, b) => {
    const pairs = a.map((value, index) => [value, b[index]]).filter((pair) => pair.every(Number.isFinite));
    if (pairs.length < 3) return 0;
    const av = mean(pairs.map((pair) => pair[0])), bv = mean(pairs.map((pair) => pair[1]));
    const num = pairs.reduce((sum, [x, y]) => sum + (x - av) * (y - bv), 0);
    const den = Math.sqrt(pairs.reduce((sum, [x]) => sum + (x - av) ** 2, 0) * pairs.reduce((sum, [, y]) => sum + (y - bv) ** 2, 0));
    return den ? num / den : 0;
  };

  function movingAverage(array, windowSize) {
    let sum = 0;
    return array.map((value, index) => {
      sum += Number.isFinite(value) ? value : 0;
      if (index >= windowSize) sum -= Number.isFinite(array[index - windowSize]) ? array[index - windowSize] : 0;
      return sum / Math.min(index + 1, windowSize);
    });
  }

  function hampel(array, radius = 7) {
    return array.map((value, index) => {
      if (!Number.isFinite(value)) return false;
      const window = array.slice(Math.max(0, index - radius), index + radius + 1).filter(Number.isFinite);
      const mid = median(window), mad = median(window.map((item) => Math.abs(item - mid)));
      return mad > 0 && Math.abs(value - mid) > 3 * 1.4826 * mad;
    });
  }

  function formatDate(date, withDate = false) {
    if (!date) return "—";
    return new Intl.DateTimeFormat("ko-KR", withDate ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  }

  function calculate(rows) {
    const raw = rows.map((row) => row.raw), ref = rows.map((row) => row.reference), vib = rows.map((row) => row.vibration), pressure = rows.map((row) => row.pressure);
    const anomalyFlags = hampel(raw);
    const pairs = raw.map((value, index) => [value, ref[index]]).filter((pair) => pair.every(Number.isFinite));
    const rmse = pairs.length ? Math.sqrt(mean(pairs.map(([a, b]) => (a - b) ** 2))) : null;
    const eventCounts = rows.reduce((map, row) => map.set(row.event, (map.get(row.event) || 0) + 1), new Map());
    const abnormal = rows.filter((row) => !/정상|normal/i.test(row.event)).length;
    const tempVals = raw.filter(Number.isFinite), vibVals = vib.filter(Number.isFinite), pressureVals = pressure.filter(Number.isFinite);
    const quality = Math.max(45, Math.min(99, Math.round(100 - (anomalyFlags.filter(Boolean).length / rows.length) * 160 - (rmse || 0) * 2.2)));
    return { raw, ref, vib, pressure, smooth: movingAverage(raw, state.smooth), anomalyFlags, rmse, eventCounts, abnormal, quality, tempVals, vibVals, pressureVals, corrVib: correlation(raw, vib), corrPressure: correlation(raw, pressure) };
  }

  function svgEl(tag, attrs = {}) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value)); return node;
  }

  function renderChart(svg, rows, series, { normalized = false, showEvents = false } = {}) {
    svg.replaceChildren();
    if (!rows.length || !series.length) { svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" class="axis-label">표시할 데이터가 없습니다.</text>'; return; }
    const width = 900, height = normalized ? 250 : 310, margin = { top: 18, right: 18, bottom: 30, left: 47 }, plotW = width - margin.left - margin.right, plotH = height - margin.top - margin.bottom;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    let rendered = series.map((item) => ({ ...item, values: item.values.slice() }));
    if (normalized) rendered = rendered.map((item) => { const valid = item.values.filter(Number.isFinite), m = mean(valid), s = std(valid) || 1; return { ...item, values: item.values.map((value) => Number.isFinite(value) ? (value - m) / s : null) }; });
    const all = rendered.flatMap((item) => item.values.filter(Number.isFinite));
    let yMin = Math.min(...all), yMax = Math.max(...all); const pad = (yMax - yMin || 1) * .12; yMin -= pad; yMax += pad;
    const x = (index) => margin.left + (index / Math.max(1, rows.length - 1)) * plotW;
    const y = (value) => margin.top + (1 - (value - yMin) / (yMax - yMin)) * plotH;
    if (showEvents) rows.forEach((row, index) => { if (!/정상|normal/i.test(row.event)) svg.append(svgEl("rect", { class: "event-band", x: x(index), y: margin.top, width: Math.max(1.3, plotW / rows.length), height: plotH })); });
    for (let i = 0; i <= 4; i++) {
      const py = margin.top + (plotH * i) / 4, value = yMax - ((yMax - yMin) * i) / 4;
      svg.append(svgEl("line", { class: normalized && Math.abs(value) < .3 ? "zero-line" : "grid-line", x1: margin.left, x2: width - margin.right, y1: py, y2: py }));
      const label = svgEl("text", { class: "axis-label", x: margin.left - 9, y: py + 3, "text-anchor": "end" }); label.textContent = normalized ? value.toFixed(1) : value.toFixed(1); svg.append(label);
    }
    for (let i = 0; i <= 4; i++) {
      const index = Math.round((rows.length - 1) * i / 4), label = svgEl("text", { class: "axis-label", x: x(index), y: height - 7, "text-anchor": i === 0 ? "start" : i === 4 ? "end" : "middle" });
      label.textContent = formatDate(rows[index]?.time); svg.append(label);
    }
    rendered.forEach((item) => {
      const step = Math.max(1, Math.ceil(item.values.length / 720)); let d = "", started = false;
      for (let index = 0; index < item.values.length; index += step) {
        const value = item.values[index]; if (!Number.isFinite(value)) { started = false; continue; }
        d += `${started ? "L" : "M"}${x(index).toFixed(2)},${y(value).toFixed(2)}`; started = true;
      }
      svg.append(svgEl("path", { class: "line-path", d, stroke: item.color }));
    });
    svg._scale = { width, height, margin, plotW, plotH, yMin, yMax, x, y };
  }

  function renderTemperature(rows, calc) {
    const series = [
      { key: "raw", color: palette.raw, values: calc.raw },
      { key: "smooth", color: palette.smooth, values: calc.smooth },
      { key: "reference", color: palette.reference, values: calc.ref }
    ].filter((item) => !state.hidden.has(item.key) && item.values.some(Number.isFinite));
    renderChart($("#tempChart"), rows, series, { showEvents: true });
    state.tempView = { rows, calc, series };
  }

  function renderKpis(rows, calc) {
    const minT = Math.min(...calc.tempVals), maxT = Math.max(...calc.tempVals), avgT = mean(calc.tempVals), avgV = mean(calc.vibVals), maxV = calc.vibVals.length ? Math.max(...calc.vibVals) : null;
    $("#avgTemp").textContent = calc.tempVals.length ? `${avgT.toFixed(2)} °C` : "—";
    $("#tempRange").textContent = calc.tempVals.length ? `범위 ${minT.toFixed(1)} — ${maxT.toFixed(1)} °C` : "온도 열 없음";
    $("#rmse").textContent = calc.rmse == null ? "N/A" : `${calc.rmse.toFixed(2)} °C`;
    $("#avgVib").textContent = calc.vibVals.length ? `${avgV.toFixed(2)} mm/s` : "N/A";
    $("#vibPeak").textContent = maxV == null ? "진동 열 없음" : `최대 ${maxV.toFixed(2)} mm/s`;
    $("#eventCount").textContent = `${fmt.format(calc.abnormal)}건`;
    $("#eventRate").textContent = `전체 관측치의 ${(calc.abnormal / rows.length * 100).toFixed(1)}%`;
  }

  function renderInsights(rows, calc) {
    $("#qualityScore").textContent = calc.quality;
    $("#scoreRing").style.setProperty("--score", calc.quality);
    const maxAnomalyIndex = calc.raw.reduce((best, value, index) => {
      if (!Number.isFinite(value)) return best; const base = calc.smooth[index] || value; return Math.abs(value - base) > best.delta ? { index, delta: Math.abs(value - base) } : best;
    }, { index: 0, delta: 0 }).index;
    const corrText = Math.abs(calc.corrVib) >= .65 ? "강한 동조" : Math.abs(calc.corrVib) >= .35 ? "중간 동조" : "약한 동조";
    const eventTop = [...calc.eventCounts.entries()].filter(([name]) => !/정상|normal/i.test(name)).sort((a, b) => b[1] - a[1])[0];
    const items = [
      { tone: "#ff7d73", title: "최대 온도 이탈", body: `${formatDate(rows[maxAnomalyIndex]?.time, true)}에 이동평균 대비 ${calc.raw[maxAnomalyIndex] >= calc.smooth[maxAnomalyIndex] ? "+" : "−"}${Math.abs(calc.raw[maxAnomalyIndex] - calc.smooth[maxAnomalyIndex]).toFixed(2)} °C` },
      { tone: "#ffbd68", title: "온도·진동 관계", body: `상관계수 ${calc.corrVib.toFixed(2)} · ${corrText} 패턴이 관찰됩니다.` },
      { tone: "#5ee6c4", title: eventTop ? `주요 이벤트 · ${eventTop[0]}` : "이벤트 상태", body: eventTop ? `${eventTop[1]}건 기록되어 이상 이벤트 중 가장 빈도가 높습니다.` : "현재 범위에서 별도 이상 이벤트가 없습니다." }
    ];
    $("#insightList").innerHTML = items.map((item) => `<div class="insight" style="--tone:${item.tone}"><i></i><div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.body)}</span></div></div>`).join("");
  }

  function renderEvents(rows, calc) {
    const sorted = [...calc.eventCounts.entries()].sort((a, b) => b[1] - a[1]);
    const maxCount = sorted[0]?.[1] || 1, tones = ["#5ee6c4", "#7da2ff", "#ffbd68", "#ff7d73", "#b08cff", "#4bc0e8", "#ec709b"];
    $("#eventBars").innerHTML = sorted.slice(0, 7).map(([name, count], index) => `<div class="event-row"><span title="${escapeHtml(name)}">${escapeHtml(name)}</span><div class="event-track"><div class="event-fill" style="width:${count / maxCount * 100}%;--bar:${tones[index % tones.length]}"></div></div><b>${fmt.format(count)}</b></div>`).join("");
    const normal = sorted.find(([name]) => /정상|normal/i.test(name))?.[1] || 0;
    $("#normalRate").textContent = `${(normal / rows.length * 100).toFixed(1)}% 정상`;
  }

  function renderTable() {
    const { headers, rows } = state.data;
    const query = state.search.trim().toLowerCase();
    const filtered = query ? rows.filter((row) => row.source.some((cell) => String(cell ?? "").toLowerCase().includes(query))) : rows;
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)); state.page = Math.min(state.page, pages);
    const pageRows = filtered.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    $("#tableHead").innerHTML = `<tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr>`;
    $("#tableBody").innerHTML = pageRows.map((row) => `<tr>${row.source.map((cell, index) => {
      let value = cell; if (index === state.data.columns.time) value = formatDate(parseTime(cell), true);
      if (typeof value === "number") value = Number.isInteger(value) ? fmt.format(value) : value.toFixed(3);
      if (index === state.data.columns.event) return `<td><span class="event-chip ${/정상|normal/i.test(String(value)) ? "" : "abnormal"}">${escapeHtml(value)}</span></td>`;
      return `<td>${escapeHtml(value)}</td>`;
    }).join("")}</tr>`).join("");
    $("#tableStatus").textContent = `${fmt.format(filtered.length)}개 기록 중 ${fmt.format((state.page - 1) * PAGE_SIZE + (pageRows.length ? 1 : 0))}–${fmt.format(Math.min(state.page * PAGE_SIZE, filtered.length))}`;
    $("#pageLabel").textContent = `${state.page} / ${pages}`; $("#prevPage").disabled = state.page <= 1; $("#nextPage").disabled = state.page >= pages;
  }

  function renderAll() {
    const rows = visibleRows(), calc = calculate(rows);
    renderKpis(rows, calc); renderTemperature(rows, calc); renderInsights(rows, calc); renderEvents(rows, calc);
    const multiSeries = [
      { color: palette.smooth, values: calc.raw, key: "temp" },
      { color: palette.vibration, values: calc.vib, key: "vibration" },
      { color: palette.pressure, values: calc.pressure, key: "pressure" }
    ].filter((item) => item.values.some(Number.isFinite));
    renderChart($("#multiChart"), rows, multiSeries, { normalized: true }); renderTable();
    const dated = rows.filter((row) => row.time); const start = dated[0]?.time, end = dated[dated.length - 1]?.time;
    $("#periodText").textContent = start && end ? `${formatDate(start, true)} — ${formatDate(end, true)} · ${fmt.format(rows.length)}건` : `${fmt.format(rows.length)}건 분석`;
  }

  function setData(payload) {
    state.data = prepareData(payload); state.page = 1; state.search = ""; $("#recordSearch").value = "";
    $("#sourceName").textContent = payload.fileName || "로컬 데이터"; $("#sourceMeta").textContent = `${payload.sheetName || "시트 1"} · ${fmt.format(state.data.rows.length)}행`;
    renderAll();
  }

  async function unzip(arrayBuffer) {
    const view = new DataView(arrayBuffer); let eocd = -1;
    for (let index = view.byteLength - 22; index >= Math.max(0, view.byteLength - 65558); index--) if (view.getUint32(index, true) === 0x06054b50) { eocd = index; break; }
    if (eocd < 0) throw new Error("올바른 XLSX 파일이 아닙니다.");
    const entries = view.getUint16(eocd + 10, true), centralOffset = view.getUint32(eocd + 16, true), files = new Map(); let cursor = centralOffset;
    for (let n = 0; n < entries; n++) {
      if (view.getUint32(cursor, true) !== 0x02014b50) break;
      const method = view.getUint16(cursor + 10, true), compressedSize = view.getUint32(cursor + 20, true), nameLen = view.getUint16(cursor + 28, true), extraLen = view.getUint16(cursor + 30, true), commentLen = view.getUint16(cursor + 32, true), localOffset = view.getUint32(cursor + 42, true);
      const name = new TextDecoder().decode(new Uint8Array(arrayBuffer, cursor + 46, nameLen));
      const localNameLen = view.getUint16(localOffset + 26, true), localExtraLen = view.getUint16(localOffset + 28, true), dataStart = localOffset + 30 + localNameLen + localExtraLen;
      let bytes = new Uint8Array(arrayBuffer.slice(dataStart, dataStart + compressedSize));
      if (method === 8) {
        if (!("DecompressionStream" in window)) throw new Error("이 브라우저는 XLSX 압축 해제를 지원하지 않습니다. 최신 Chrome 또는 Edge를 이용해 주세요.");
        bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
      } else if (method !== 0) throw new Error("지원하지 않는 XLSX 압축 방식입니다.");
      files.set(name.replace(/^\//, ""), bytes); cursor += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  const xmlText = (files, path) => { const bytes = files.get(path); return bytes ? new TextDecoder("utf-8").decode(bytes) : ""; };
  const parseXml = (text) => new DOMParser().parseFromString(text, "application/xml");
  const childText = (node, tag) => node?.getElementsByTagName(tag)[0]?.textContent ?? "";
  const columnIndex = (ref) => [...ref.replace(/\d/g, "")].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;

  async function parseWorkbook(file) {
    const files = await unzip(await file.arrayBuffer());
    const sharedDoc = parseXml(xmlText(files, "xl/sharedStrings.xml"));
    const shared = [...sharedDoc.getElementsByTagName("si")].map((item) => [...item.getElementsByTagName("t")].map((text) => text.textContent).join(""));
    const workbookDoc = parseXml(xmlText(files, "xl/workbook.xml")), relsDoc = parseXml(xmlText(files, "xl/_rels/workbook.xml.rels"));
    const rels = new Map([...relsDoc.getElementsByTagName("Relationship")].map((rel) => [rel.getAttribute("Id"), rel.getAttribute("Target")]));
    const sheets = [...workbookDoc.getElementsByTagName("sheet")].map((sheet) => ({ name: sheet.getAttribute("name"), id: sheet.getAttribute("r:id") || sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") }));
    const candidates = [];
    for (const sheet of sheets) {
      const target = rels.get(sheet.id) || "worksheets/sheet1.xml", path = `xl/${target.replace(/^\.\.\//, "")}`.replace("xl//", "xl/");
      const doc = parseXml(xmlText(files, path)); if (!doc.documentElement) continue;
      const rows = [...doc.getElementsByTagName("row")].map((rowNode) => {
        const row = [];
        [...rowNode.getElementsByTagName("c")].forEach((cell) => {
          const index = columnIndex(cell.getAttribute("r") || "A1"), type = cell.getAttribute("t"), raw = childText(cell, "v"); let value = raw;
          if (type === "s") value = shared[Number(raw)] ?? "";
          else if (type === "inlineStr") value = childText(cell, "t");
          else if (type === "b") value = raw === "1";
          else if (raw !== "" && Number.isFinite(Number(raw))) value = Number(raw);
          row[index] = value;
        }); return row;
      }).filter((row) => row.some((cell) => cell !== undefined && cell !== ""));
      if (rows.length > 1) candidates.push({ fileName: file.name, sheetName: sheet.name, headers: rows[0].map((value) => String(value ?? "")), rows: rows.slice(1) });
    }
    if (!candidates.length) throw new Error("데이터가 들어 있는 시트를 찾지 못했습니다.");
    return candidates.sort((a, b) => b.rows.length - a.rows.length)[0];
  }

  async function handleFile(file) {
    if (!file || !/\.xls(x|m)$/i.test(file.name)) { toast(".xlsx 또는 .xlsm 파일을 선택해 주세요."); return; }
    try { toast("엑셀을 이 기기에서 분석하고 있습니다…"); setData(await parseWorkbook(file)); toast(`${file.name} 분석을 완료했습니다.`); }
    catch (error) { console.error(error); toast(error.message || "파일을 읽는 중 문제가 발생했습니다."); }
  }

  function setupInteractions() {
    $("#fileInput").addEventListener("change", (event) => handleFile(event.target.files[0]));
    const drop = $("#dropZone");
    ["dragenter", "dragover"].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove("drag"); }));
    drop.addEventListener("drop", (event) => handleFile(event.dataTransfer.files[0]));
    $$(".range-switch button").forEach((button) => button.addEventListener("click", () => { $$(".range-switch button").forEach((item) => item.classList.toggle("active", item === button)); state.hours = Number(button.dataset.hours); renderAll(); }));
    $("#smoothWindow").addEventListener("change", (event) => { state.smooth = Number(event.target.value); renderAll(); });
    $$("#tempLegend button").forEach((button) => button.addEventListener("click", () => { const key = button.dataset.series; state.hidden.has(key) ? state.hidden.delete(key) : state.hidden.add(key); button.classList.toggle("off", state.hidden.has(key)); renderAll(); }));
    $("#recordSearch").addEventListener("input", (event) => { state.search = event.target.value; state.page = 1; renderTable(); });
    $("#prevPage").addEventListener("click", () => { state.page--; renderTable(); }); $("#nextPage").addEventListener("click", () => { state.page++; renderTable(); });
    $$('nav a').forEach((link) => link.addEventListener("click", () => { $$('nav a').forEach((item) => item.classList.toggle("active", item === link)); }));
    const svg = $("#tempChart"), tip = $("#chartTooltip");
    svg.addEventListener("mousemove", (event) => {
      const view = state.tempView, scale = svg._scale; if (!view || !scale) return;
      const rect = svg.getBoundingClientRect(), localX = (event.clientX - rect.left) / rect.width * scale.width, index = Math.max(0, Math.min(view.rows.length - 1, Math.round((localX - scale.margin.left) / scale.plotW * (view.rows.length - 1))));
      const row = view.rows[index]; tip.innerHTML = `<strong>${escapeHtml(formatDate(row.time, true))}</strong>원시 ${Number.isFinite(view.calc.raw[index]) ? view.calc.raw[index].toFixed(2) + " °C" : "—"}<br>평균 ${Number.isFinite(view.calc.smooth[index]) ? view.calc.smooth[index].toFixed(2) + " °C" : "—"}<br>${escapeHtml(row.event)}`;
      tip.style.display = "block"; tip.style.left = `${Math.min(rect.width - 170, Math.max(8, event.clientX - rect.left + 12))}px`; tip.style.top = `${Math.max(8, event.clientY - rect.top - 74)}px`;
    });
    svg.addEventListener("mouseleave", () => tip.style.display = "none");
  }

  setupInteractions();
  try { setData(window.LOCAL_SEED_DATA); } catch (error) { console.error(error); toast("기본 데이터를 여는 중 문제가 발생했습니다."); }
})();
