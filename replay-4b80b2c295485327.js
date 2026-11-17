// The recording view's charts, on uPlot: the strips (one or two readings each, all on one time
// axis), the time axis above them, and the overview of the whole recording with the window being
// looked at. Rust (`src/replay.rs`) owns the state: the window, the pinned time and the time under
// the pointer. These only draw it and report what the pointer does.
//
// Times are seconds since the recording started: the box has no clock. Lines break where a value
// is NaN: the bus sent text instead of a number, or the box wasn't recording.

window.bvReplay = (function () {
  "use strict";

  const FONT = '11px Archivo, "Helvetica Neue", Arial, sans-serif';
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const gaps = (a) => Array.from(a, (v) => (Number.isNaN(v) ? null : v));

  function elapsed(s) {
    const neg = s < 0;
    s = Math.abs(Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
    const two = (n) => String(n).padStart(2, "0");
    return (neg ? "−" : "") + (h ? h + ":" + two(m) : m) + ":" + two(ss);
  }

  // A time as the axis and the readouts show it: since the recording started.
  function timeText(t) {
    return elapsed(t);
  }

  const clock = (u, vals) => vals.map(elapsed);

  function axis(show) {
    const grid = css("--grid");
    return { show, stroke: css("--muted"), font: FONT, size: show ? 26 : 0, grid: { stroke: grid, width: 1 }, ticks: { show, stroke: grid, width: 1, size: 4 } };
  }

  // A line, moved by setting `left`: the pinned time or the one under the pointer.
  function marker(u, cls) {
    const el = document.createElement("div");
    el.className = cls;
    u.over.appendChild(el);
    return el;
  }

  function place(u, el, t) {
    if (t == null || Number.isNaN(t)) {
      el.style.display = "none";
      return;
    }
    const x = u.valToPos(t, "x");
    if (x < 0 || x > u.over.clientWidth) {
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    el.style.transform = "translateX(" + x + "px)";
  }

  // Gaps in the recording, shaded.
  function drawEvents(u, events) {
    const ctx = u.ctx, { top, height } = u.bbox;
    ctx.save();
    ctx.fillStyle = css("--wash");
    for (let i = 0; i + 1 < events.gaps.length; i += 2) {
      const a = u.valToPos(events.gaps[i], "x", true), b = u.valToPos(events.gaps[i + 1], "x", true);
      ctx.fillRect(a, top, Math.max(b - a, 1), height);
    }
    ctx.restore();
  }

  // What the pointer does on a chart: hover moves the line under it, a click pins the time, a drag
  // across selects a window, a double click shows the whole recording again.
  function bindPointer(u, cb, isOverview) {
    let down = null;
    u.over.addEventListener("pointerdown", (e) => {
      down = { x: e.offsetX, y: e.offsetY, type: e.pointerType };
    });
    u.over.addEventListener("pointerup", (e) => {
      if (down && Math.abs(e.offsetX - down.x) < 4 && Math.abs(e.offsetY - down.y) < 4 && !isOverview) {
        cb.pin(u.posToVal(e.offsetX, "x"));
      }
      down = null;
    });
    u.over.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse") cb.hover(u.posToVal(e.offsetX, "x"));
    });
    u.over.addEventListener("pointerleave", () => cb.hover(NaN));
  }

  function selectHook(cb) {
    return (u) => {
      const s = u.select;
      if (s.width > 4) cb.range(u.posToVal(s.left, "x"), u.posToVal(s.left + s.width, "x"));
      if (s.width > 0) u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
    };
  }

  // spec: { series: [{ t, v, color, dash }], range: [lo, hi], kind: "linear" | "signed" |
  // "bearing", width, height, view: [t0, t1], gaps }
  function strip(el, spec, cb) {
    let view = spec.view.slice();
    let height = spec.height;
    const events = { gaps: Array.from(spec.gaps) };
    const tables = spec.series.map((s) => [Array.from(s.t), gaps(s.v)]);
    // Joined on one time axis; each series' own breaks stay breaks (uPlot's NULL_EXPAND), and the
    // other series' times in between are spanned.
    const data = tables.length === 1 ? tables[0] : uPlot.join(tables, tables.map(() => [null, 2]));
    const y = axis(true);
    y.size = 40;
    if (spec.kind === "bearing") {
      y.splits = () => [0, 90, 180, 270];
      y.values = (u, vals) => vals.map((v) => String(v % 360).padStart(3, "0"));
    } else if (spec.kind === "signed") {
      const hi = spec.range[1];
      y.splits = () => [-hi, -hi / 2, 0, hi / 2, hi];
      // Port is negative on the bus.
      y.values = (u, vals) => vals.map((v) => (v < 0 ? -v + " P" : v > 0 ? v + " S" : "0"));
    }
    const opts = {
      width: spec.width,
      height: spec.height,
      legend: { show: false },
      padding: [6, 8, 2, 0],
      cursor: {
        x: false,
        y: false,
        points: { show: false },
        drag: { x: true, y: false, setScale: false },
        bind: { dblclick: () => () => (cb.reset(), null) },
      },
      select: { show: true },
      scales: {
        x: { time: false, auto: false, range: () => view },
        y: { auto: false, range: () => spec.range },
      },
      axes: [axis(false), y],
      series: [{}].concat(spec.series.map((s) => ({
        stroke: s.color,
        width: s.dash ? 1.25 : 1.6,
        dash: s.dash ? [5, 4] : undefined,
        points: { show: false },
        spanGaps: false,
      }))),
      hooks: {
        drawAxes: [(u) => drawEvents(u, events)],
        setSelect: [selectHook(cb)],
      },
    };
    const u = new uPlot(opts, data, el);
    bindPointer(u, cb, false);
    const pin = marker(u, "rp-pin"), hover = marker(u, "rp-hover");
    return {
      setView(t0, t1) {
        view = [t0, t1];
        u.setScale("x", { min: t0, max: t1 });
      },
      setCursor(h, p) {
        place(u, hover, h);
        place(u, pin, p);
      },
      setWidth(w) {
        u.setSize({ width: w, height });
      },
      setHeight(h) {
        height = h;
        u.setSize({ width: u.width, height });
      },
      destroy() {
        u.destroy();
      },
    };
  }

  // The time axis over the strips, with the time under the pointer and the pinned time on it.
  function timeAxis(el, spec, cb) {
    let view = spec.view.slice();
    const opts = {
      width: spec.width,
      height: 30,
      legend: { show: false },
      padding: [0, 8, 0, 0],
      cursor: { show: false },
      scales: { x: { time: false, auto: false, range: () => view }, y: { auto: false, range: [0, 1] } },
      axes: [Object.assign(axis(true), { side: 0, grid: { show: false }, values: clock }), Object.assign(axis(false), { size: 40 })],
      series: [{}],
    };
    const u = new uPlot(opts, [[view[0], view[1]]], el);
    const tag = (cls) => {
      const d = marker(u, cls);
      return d;
    };
    const pin = tag("rp-tag pin"), hover = tag("rp-tag hover");
    const show = (d, t) => {
      place(u, d, t);
      if (t != null && !Number.isNaN(t)) d.textContent = timeText(t);
    };
    return {
      setView(t0, t1) {
        view = [t0, t1];
        u.setScale("x", { min: t0, max: t1 });
      },
      setCursor(h, p) {
        show(hover, h);
        show(pin, Number.isNaN(h) || h == null ? p : NaN);
      },
      setWidth(w) {
        u.setSize({ width: w, height: 30 });
      },
      destroy() {
        u.destroy();
      },
    };
  }

  // The whole recording, one channel, with the window: drag it to move it, drag its edges to
  // resize it, drag across the rest to choose another, tap to move it there.
  function overview(el, spec, cb) {
    const full = [spec.start, spec.end];
    let view = spec.view.slice();
    const events = { gaps: Array.from(spec.gaps) };
    const opts = {
      width: spec.width,
      height: spec.height,
      legend: { show: false },
      padding: [4, 8, 0, 0],
      cursor: { x: false, y: false, points: { show: false }, drag: { x: false, y: false } },
      scales: { x: { time: false, auto: false, range: () => full }, y: { auto: false, range: () => spec.range } },
      axes: [Object.assign(axis(true), { values: clock }), Object.assign(axis(false), { size: 40 })],
      series: [{}, { stroke: spec.color, width: 1.25, fill: spec.fill, points: { show: false }, spanGaps: false }],
      hooks: { drawAxes: [(u) => drawEvents(u, events)] },
    };
    const u = new uPlot(opts, [Array.from(spec.t), gaps(spec.v)], el);
    const win = marker(u, "rp-window");
    ["l", "r"].forEach((side) => {
      const h = document.createElement("i");
      h.className = "rp-grip " + side;
      win.appendChild(h);
    });
    const pin = marker(u, "rp-pin"), hover = marker(u, "rp-hover");
    const drawWindow = () => {
      const a = u.valToPos(view[0], "x"), b = u.valToPos(view[1], "x");
      win.style.transform = "translateX(" + a + "px)";
      win.style.width = Math.max(b - a, 2) + "px";
    };
    drawWindow();
    // From the chart's left edge: `offsetX` would be from the window's box when over it.
    const px = (e) => e.clientX - u.over.getBoundingClientRect().left;
    let drag = null;
    const minSpan = Math.min(10, (full[1] - full[0]) / 2);
    const clamp = (t0, t1) => {
      const span = t1 - t0;
      if (t0 < full[0]) return [full[0], full[0] + span];
      if (t1 > full[1]) return [full[1] - span, full[1]];
      return [t0, t1];
    };
    u.over.addEventListener("pointerdown", (e) => {
      u.over.setPointerCapture(e.pointerId);
      const t = u.posToVal(px(e), "x");
      const a = u.valToPos(view[0], "x"), b = u.valToPos(view[1], "x");
      const grip = e.pointerType === "touch" ? 14 : 7;
      let mode = "new";
      if (Math.abs(px(e) - a) <= grip) mode = "l";
      else if (Math.abs(px(e) - b) <= grip) mode = "r";
      // Inside the window moves it, unless it is the whole recording: then a drag chooses one.
      else if (px(e) > a && px(e) < b && view[1] - view[0] < (full[1] - full[0]) * 0.98) mode = "move";
      drag = { mode, x: px(e), t, view: view.slice(), moved: false };
      e.preventDefault();
    });
    u.over.addEventListener("pointermove", (e) => {
      if (!drag) {
        if (e.pointerType === "mouse") cb.hover(u.posToVal(px(e), "x"));
        return;
      }
      if (Math.abs(px(e) - drag.x) > 3) drag.moved = true;
      if (!drag.moved) return;
      const t = Math.min(Math.max(u.posToVal(px(e), "x"), full[0]), full[1]);
      let next;
      if (drag.mode === "move") next = clamp(drag.view[0] + t - drag.t, drag.view[1] + t - drag.t);
      else if (drag.mode === "l") next = [Math.min(t, drag.view[1] - minSpan), drag.view[1]];
      else if (drag.mode === "r") next = [drag.view[0], Math.max(t, drag.view[0] + minSpan)];
      else next = [Math.min(t, drag.t), Math.max(t, drag.t)];
      if (next[1] - next[0] >= minSpan) cb.range(next[0], next[1]);
    });
    const end = (e) => {
      if (drag && !drag.moved) {
        // A tap: the window moves there, the same size, and the time there is pinned.
        const span = view[1] - view[0];
        const next = clamp(drag.t - span / 2, drag.t + span / 2);
        if (span < full[1] - full[0]) cb.range(next[0], next[1]);
        cb.pin(drag.t);
      }
      drag = null;
    };
    u.over.addEventListener("pointerup", end);
    u.over.addEventListener("pointercancel", () => (drag = null));
    u.over.addEventListener("pointerleave", () => { if (!drag) cb.hover(NaN); });
    u.over.addEventListener("dblclick", () => cb.reset());
    return {
      setView(t0, t1) {
        view = [t0, t1];
        drawWindow();
      },
      setCursor(h, p) {
        place(u, hover, h);
        place(u, pin, p);
      },
      setWidth(w) {
        u.setSize({ width: w, height: spec.height });
        drawWindow();
      },
      destroy() {
        u.destroy();
      },
    };
  }

  return { strip, timeAxis, overview, timeText };
})();
