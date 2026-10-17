"use strict";

(() => {
  const API_BASE = "/_dsh/quota-plan";
  const $ = (id) => document.getElementById(id);
  const dateFormatter = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const timeFormatter = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const fullTimeFormatter = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const updateTimeFormatter = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
  const dayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
  const requestControllers = new Set();
  const state = { status: null, loading: false, saving: false, generation: 0, chartKey: null, requestsKey: null, pricingRows: [], toastTimer: null, actionError: null, connectionFailed: false, requestSearch: "", requestFilter: "all", requestExpanded: false, requestRows: new Map(), emptyRequestRow: null, chartColumns: new Map(), pageActive: true };
  Object.assign(state, { pricingRoutes: [], pricingAliases: [], pricingModelList: [], pricingShown: 0, syncingPrices: false });

  function number(value, fallback = 0) {
    const result = Number(value);
    return Number.isFinite(result) ? result : fallback;
  }

  function percent(value) {
    const n = Math.max(0, number(value));
    if (n > 0 && n < 1) return "< 1%";
    return `${Math.round(n)}%`;
  }

  function weeklyPercent(value) {
    const limit = number(state.status?.windows.weekly.limitUsd, number(state.status?.config.weeklyLimitUsd, 20));
    return limit > 0 ? Math.max(0, number(value)) / limit * 100 : 0;
  }

  function dateOf(value) {
    if (value === null || value === undefined || value === "") return null;
    const numericValue = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : value;
    const date = new Date(numericValue);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function dayOf(value) {
    return dayFormatter.format(dateOf(value) || new Date());
  }

  function setText(id, value) {
    const element = $(id);
    if (element && element.textContent !== String(value)) element.textContent = value;
  }

  function safeMessage(message) {
    return String(message || "请求失败，请稍后重试。")
      .replace(/\$\s*\d[\d,]*(?:\.\d+)?/g, "对应额度")
      .replace(/\bUSD\s*\d[\d,]*(?:\.\d+)?/gi, "对应额度")
      .replace(/\d[\d,]*(?:\.\d+)?\s*(?:USD\b|美元)/gi, "对应额度");
  }

  function setBusy() {
    const busy = state.loading || state.saving;
    $("usage")?.setAttribute("aria-busy", String(busy));
    $("usage")?.classList.toggle("is-loading", !state.status && busy);
  }

  function setRefreshLoading(loading, label = false) {
    const button = $("refresh-button");
    if (!button) return;
    button.disabled = loading;
    button.setAttribute("aria-busy", String(loading));
    button.setAttribute("aria-label", loading ? "正在更新用量" : "刷新用量");
    let caption = button.querySelector("[data-button-label], span");
    if (!caption) { caption = document.createElement("span"); button.append(caption); }
    caption.textContent = loading && label ? "刷新中…" : "刷新";
  }

  function setConnection(connected) {
    state.connectionFailed = !connected;
    $("usage")?.classList.toggle("is-offline", !connected);
    $("connection-dot").className = `status-dot ${connected ? "connected" : "error"}`;
    setText("connection-label", connected ? "本地服务已连接" : "连接中断");
  }

  function showError(message, persistent = false) {
    const text = safeMessage(message);
    if (persistent) state.actionError = text;
    setText("error-message", text);
    $("error-banner").hidden = false;
  }

  function toast(message) {
    clearTimeout(state.toastTimer);
    setText("toast", message);
    $("toast").hidden = false;
    state.toastTimer = setTimeout(() => { $("toast").hidden = true; }, 3500);
  }

  async function request(path, options = {}) {
    const controller = new AbortController();
    requestControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`${API_BASE}${path}`, { ...options, cache: "no-store", credentials: "same-origin", signal: controller.signal, headers: { Accept: "application/json", ...(options.headers || {}) } });
      let body;
      try { body = await response.json(); } catch { throw new Error(response.ok ? "服务返回了无效数据，请检查插件是否正常运行。" : `服务请求失败（HTTP ${response.status}）。`); }
      if (!response.ok) {
        const error = new Error(body.error?.message || (typeof body.error === "string" ? body.error : null) || body.message || `服务请求失败（HTTP ${response.status}）。`);
        error.status = response.status;
        throw error;
      }
      return body;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("连接超时，请检查本地服务后重试。");
      if (error instanceof TypeError) throw new Error("无法连接本地服务，请确认 DeepSeek Harness 和额度插件正在运行。");
      throw error;
    } finally { clearTimeout(timeout); requestControllers.delete(controller); }
  }

  function validateStatus(status) {
    if (!status || !status.windows?.fiveHour || !status.windows?.weekly || !status.config) throw new Error("额度数据不完整，请检查插件服务版本。");
    return status;
  }

  async function refresh({ manual = false } = {}) {
    if (!state.pageActive || state.loading || state.saving) return;
    state.loading = true;
    const generation = state.generation;
    const recovering = state.connectionFailed;
    setRefreshLoading(true, manual || !state.status);
    setBusy();
    try {
      const status = validateStatus(await request("/api/status"));
      if (!state.pageActive || generation !== state.generation) return;
      state.status = status;
      if (manual) state.actionError = null;
      $("error-banner").hidden = !state.actionError;
      if (state.actionError) setText("error-message", state.actionError);
      render(status);
      setConnection(true);
      if (manual) toast("用量已更新");
      else if (recovering) toast("连接已恢复，用量已更新");
    } catch (error) {
      if (!state.pageActive || generation !== state.generation) return;
      setConnection(false);
      showError(state.actionError || error.message);
      if (!state.status) {
        $("plan-badge").className = "badge badge-blocked";
        setText("plan-badge", "连接失败");
        setText("plan-status-text", "请启动本地额度服务后刷新。");
      }
    } finally {
      state.loading = false;
      setRefreshLoading(false);
      setBusy();
    }
  }

  function renderWindow(prefix, window, enabled) {
    const limit = Math.max(0, number(window.limitUsd));
    const used = Math.max(0, number(window.usedUsd));
    const reserved = Math.max(0, number(window.reservedUsd));
    const remaining = Math.max(0, number(window.remainingUsd, limit - used - reserved));
    const usedPercent = limit > 0 ? Math.min(100, used / limit * 100) : 0;
    const reservedPercent = limit > 0 ? Math.min(100 - usedPercent, reserved / limit * 100) : 0;
    const exhausted = enabled && (remaining <= 0 || limit <= 0);
    $(`${prefix}-card`).classList.toggle("is-blocked", exhausted);
    $(`${prefix}-card`).classList.toggle("is-disabled", !enabled);
    const occupiedPercent = limit > 0 ? (used + reserved) / limit * 100 : 0;
    const warning = enabled && !exhausted && occupiedPercent >= 80;
    const critical = warning && occupiedPercent >= 95;
    $(`${prefix}-card`).classList.toggle("is-warning", warning);
    $(`${prefix}-card`).classList.toggle("is-critical", critical);
    $(`${prefix}-card`).dataset.level = !enabled ? "disabled" : exhausted ? "blocked" : critical ? "critical" : warning ? "warning" : "normal";
    setText(`${prefix}-percent`, percent(occupiedPercent));
    $(`${prefix}-percent`).title = `已使用 ${percent(limit > 0 ? used / limit * 100 : 0)}，已预留 ${percent(limit > 0 ? reserved / limit * 100 : 0)}`;
    setText(`${prefix}-used`, percent(limit > 0 ? used / limit * 100 : 0));
    setText(`${prefix}-available`, percent(limit > 0 ? remaining / limit * 100 : 0));
    setText(`${prefix}-status`, !enabled ? "未启用限制" : exhausted ? "额度已耗尽" : critical ? "接近上限" : warning ? "余量较低" : "可使用");
    const reservation = $(`${prefix}-reserved-note`);
    reservation.hidden = reserved <= 0;
    reservation.textContent = ` · 预留 ${percent(limit > 0 ? reserved / limit * 100 : 0)}`;
    $(`${prefix}-used-bar`).setAttribute("width", String(usedPercent));
    $(`${prefix}-reserved-bar`).setAttribute("x", String(usedPercent));
    $(`${prefix}-reserved-bar`).setAttribute("width", String(reservedPercent));
    $(`${prefix}-progress`).setAttribute("aria-valuenow", String(Math.round(usedPercent + reservedPercent)));
    $(`${prefix}-progress`).setAttribute("aria-valuetext", `已用 ${percent(limit > 0 ? used / limit * 100 : 0)}，预留 ${percent(limit > 0 ? reserved / limit * 100 : 0)}`);
    const reset = dateOf(window.resetsAt);
    setText(`${prefix}-reset-date`, reset ? dateFormatter.format(reset) : "首次请求后开始计时");
    $(`${prefix}-reset-date`).title = reset ? `${fullTimeFormatter.format(reset)}（北京时间）` : "首次请求后开始额度窗口，按北京时间显示";
  }

  function render(status) {
    const enabled = status.config.enabled !== false;
    const integration = status.integration || {};
    const ledgerFailure = integration.ledgerFailure;
    const blockedReason = status.blockedReason || ledgerFailure;
    renderWindow("five-hour", status.windows.fiveHour, enabled && status.config.fiveHourEnabled !== false);
    renderWindow("weekly", status.windows.weekly, enabled);
    const exhausted = enabled && (number(status.windows.weekly.remainingUsd) <= 0 || (status.config.fiveHourEnabled !== false && number(status.windows.fiveHour.remainingUsd) <= 0));
    const blocked = !!blockedReason;
    const enabledWindows = enabled ? [status.windows.weekly, ...(status.config.fiveHourEnabled !== false ? [status.windows.fiveHour] : [])] : [];
    const peakPercent = Math.max(0, ...enabledWindows.map((window) => number(window.limitUsd) > 0 ? (number(window.usedUsd) + number(window.reservedUsd)) / number(window.limitUsd) * 100 : 100));
    const warning = peakPercent >= 80;
    const critical = peakPercent >= 95;
    const badge = $("plan-badge");
    badge.className = `badge ${blocked || exhausted ? "badge-blocked" : !enabled ? "badge-neutral" : critical ? "badge-warning badge-critical" : warning ? "badge-warning" : "badge-good"}`;
    badge.textContent = blocked || exhausted ? "请求受限" : !enabled ? "限制已暂停" : critical ? "额度即将用完" : warning ? "剩余额度较低" : "额度可用";
    setText("plan-status-text", !enabled ? "限制已暂停；历史用量保留，当前请求不计入新用量。" : blocked || exhausted ? "请留意窗口重置时间或检查最近的拦截原因。" : critical ? "剩余空间有限，请留意窗口重置时间。" : warning ? "已使用较多额度，进行中的请求也会占用预留。" : "所有会话共享额度");
    const rejection = integration.lastRejection;
    $("blocked-banner").hidden = !blocked && !rejection?.message;
    $("blocked-banner").querySelector("strong").textContent = blocked ? "请求暂时受限" : "最近一次请求被拦截";
    setText("blocked-reason", blockedReason || rejection?.message ? safeMessage(blockedReason || `${rejection.message}${dateOf(rejection.at) ? ` · ${timeFormatter.format(dateOf(rejection.at))}` : ""}`) : "");
    $("blocked-reason").title = dateOf(rejection?.at) ? `${fullTimeFormatter.format(dateOf(rejection.at))}（北京时间）` : "";
    if (ledgerFailure) showError(state.actionError || `用量记录异常：${ledgerFailure}`);
    else if (state.actionError) showError(state.actionError);
    $("open-settings").disabled = false;
    $("sidebar-settings").disabled = false;
    setText("last-updated", `更新于 ${updateTimeFormatter.format(new Date())}`);
    $("last-updated").title = "用量每 5 秒自动更新，时间为北京时间";
    const note = integration.label || "DeepSeek Harness 额度插件";
    setText("integration-note", `${note}${status.version ? ` · v${status.version}` : ""}`);
    renderChart(status.daily || []);
    renderRequests(status.recent || []);
    renderPricingStatus();
    updateCountdowns();
  }

  function updateCountdowns() {
    if (!state.status) return;
    for (const [prefix, key] of [["five-hour", "fiveHour"], ["weekly", "weekly"]]) {
      const reset = dateOf(state.status.windows[key].resetsAt);
      if (!reset) { setText(`${prefix}-countdown`, "尚未开始"); continue; }
      const seconds = Math.max(0, Math.ceil((reset.getTime() - Date.now()) / 1000));
      if (seconds <= 0) { setText(`${prefix}-countdown`, "正在重置…"); continue; }
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const rest = seconds % 60;
      setText(`${prefix}-countdown`, days ? `${days} 天 ${hours} 小时` : seconds >= 3600 ? `${hours} 小时 ${minutes} 分` : `${minutes} 分 ${String(rest).padStart(2, "0")} 秒`);
    }
  }

  function lastSevenDays() {
    const today = dayOf(new Date());
    const anchor = new Date(`${today}T12:00:00+08:00`).getTime();
    return Array.from({ length: 7 }, (_, index) => dayOf(new Date(anchor - (6 - index) * 86400000)));
  }

  function createSvg(name, attributes) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }

  function renderChart(daily) {
    const days = lastSevenDays();
    const amounts = new Map(daily.map((item) => [String(item.date).slice(0, 10), Math.max(0, number(item.costUsd))]));
    const points = days.map((date) => ({ date, amount: weeklyPercent(amounts.get(date) || 0) }));
    const key = JSON.stringify(points);
    if (state.chartKey === key) return;
    state.chartKey = key;
    const largest = Math.max(...points.map((item) => item.amount), 0);
    const empty = largest <= 0;
    const magnitude = largest > 0 ? 10 ** Math.floor(Math.log10(largest)) : 1;
    const scaleStep = Math.max(2, magnitude);
    const maximum = Math.max(scaleStep, Math.ceil(largest / scaleStep) * scaleStep);
    setText("chart-scale-top", empty ? "—" : percent(maximum));
    setText("chart-scale-middle", empty ? "—" : percent(maximum / 2));
    setText("chart-total", percent(points.reduce((sum, item) => sum + item.amount, 0)));
    const chart = $("daily-chart");
    const emptyMessage = $("chart-empty");
    if (emptyMessage) {
      emptyMessage.hidden = !empty;
      const description = emptyMessage.querySelector("span");
      if (description) description.textContent = "开始一次对话后，就能在这里查看近 7 天的用量趋势。";
      else if (!emptyMessage.children.length) emptyMessage.textContent = "还没有已结算用量。发起一次请求后，可以在这里查看近 7 天的使用趋势。";
    }
    chart.hidden = empty;
    chart.closest(".activity-card")?.classList.toggle("is-empty", empty);
    const layout = chart.closest(".chart-layout");
    if (layout) {
      layout.querySelectorAll(".chart-scale, .chart-guides").forEach((element) => { element.hidden = empty; });
      if (emptyMessage && !layout.contains(emptyMessage)) layout.hidden = empty;
    }
    chart.setAttribute("aria-label", `近 7 天用量占每周额度比例：${points.map((item) => `${item.date} ${percent(item.amount)}`).join("，")}`);
    if (empty) return;
    const liveDates = new Set(days);
    for (const [date, entry] of state.chartColumns) {
      if (!liveDates.has(date)) { entry.column.remove(); state.chartColumns.delete(date); }
    }
    points.forEach((item, index) => {
      let entry = state.chartColumns.get(item.date);
      if (!entry) {
        const column = document.createElement("div");
        column.tabIndex = 0;
        column.dataset.date = item.date;
        const svg = createSvg("svg", { viewBox: "0 0 47 134", "aria-hidden": "true" });
        const bar = createSvg("rect", { class: "chart-bar", x: 0, width: 47, rx: 4 });
        svg.append(bar);
        const day = document.createElement("span"); day.className = "chart-day";
        const tooltip = document.createElement("span"); tooltip.className = "chart-tooltip"; tooltip.setAttribute("aria-hidden", "true");
        column.append(svg, day, tooltip);
        entry = { column, bar, day, tooltip };
        state.chartColumns.set(item.date, entry);
      }
      const { column, bar, day, tooltip } = entry;
      column.className = `chart-column${index === 6 ? " today" : ""}${item.amount <= 0 ? " zero" : ""}`;
      column.setAttribute("aria-label", `${item.date} 用量占每周额度 ${percent(item.amount)}`);
      const height = item.amount > 0 ? Math.max(4, item.amount / maximum * 124) : 3;
      bar.setAttribute("y", String(130 - height));
      bar.setAttribute("height", String(height));
      day.textContent = index === 6 ? "今天" : `${Number(item.date.slice(5, 7))}/${Number(item.date.slice(8, 10))}`;
      tooltip.textContent = percent(item.amount);
      if (chart.children[index] !== column) chart.insertBefore(column, chart.children[index] || null);
    });
  }

  function statusLabel(value) {
    const text = String(value || "completed");
    if (["completed", "success", "succeeded", "settled", "ok"].includes(text)) return { label: "已完成", className: "success" };
    if (["reserved", "pending", "running", "in_progress"].includes(text)) return { label: "进行中", className: "pending" };
    if (text === "estimated") return { label: "保守结算", className: "pending" };
    if (["blocked", "rejected", "denied"].includes(text)) return { label: "已拦截", className: "error" };
    if (["failed", "error", "cancelled", "canceled"].includes(text)) return { label: text.startsWith("cancel") ? "已取消" : "失败", className: "error" };
    return { label: text, className: "" };
  }

  function requestCategory(value) {
    const text = String(value || "completed");
    if (["completed", "success", "succeeded", "settled", "ok"].includes(text)) return "completed";
    if (["reserved", "pending", "running", "in_progress"].includes(text)) return "pending";
    if (text === "estimated") return "estimated";
    if (["blocked", "rejected", "denied", "failed", "error", "cancelled", "canceled"].includes(text)) return "failed";
    return "other";
  }

  function createRequestRow() {
    const row = document.createElement("tr");
    const modelCell = document.createElement("td");
    const model = document.createElement("span"); model.className = "request-model";
    const session = document.createElement("span"); session.className = "request-session";
    modelCell.append(model, session);
    const time = document.createElement("td");
    const statusCell = document.createElement("td");
    const badge = document.createElement("span"); statusCell.append(badge);
    const cost = document.createElement("td"); cost.className = "text-right"; cost.title = "占每周额度的比例";
    row.append(modelCell, time, statusCell, cost);
    return { row, model, session, time, badge, cost };
  }

  function getEmptyRequestRow(filtered) {
    if (!state.emptyRequestRow) {
      const row = document.createElement("tr");
      const cell = document.createElement("td"); cell.colSpan = 4; cell.className = "empty-state";
      const icon = document.createElement("span"); icon.className = "empty-state-icon"; icon.textContent = "↗"; icon.setAttribute("aria-hidden", "true");
      const heading = document.createElement("strong");
      const description = document.createElement("span");
      cell.append(icon, heading, description); row.append(cell);
      state.emptyRequestRow = { row, heading, description };
    }
    state.emptyRequestRow.heading.textContent = filtered ? "没有符合条件的请求" : "暂无请求记录";
    state.emptyRequestRow.description.textContent = filtered ? "试试其他关键词或切换为全部状态。" : "发起模型请求后，用量会自动出现在这里。";
    return state.emptyRequestRow.row;
  }

  function renderRequests(recent) {
    const key = JSON.stringify([recent, state.status?.windows.weekly.limitUsd, state.requestSearch, state.requestFilter, state.requestExpanded]);
    if (state.requestsKey === key) return;
    state.requestsKey = key;
    const query = state.requestSearch.trim().toLocaleLowerCase();
    const filtered = !!query || state.requestFilter !== "all";
    const visible = recent.filter((item) => (state.requestFilter === "all" || requestCategory(item.status) === state.requestFilter)
      && (!query || [item.model, item.sessionId, item.id].some((value) => String(value || "").toLocaleLowerCase().includes(query))));
    setText("request-count", filtered ? `${visible.length} / ${recent.length} 条` : `${recent.length} 条记录`);
    const body = $("requests-body");
    if ($("requests-empty")) $("requests-empty").hidden = true;
    const retained = new Set(recent.map((item, index) => String(item.id || `${item.model}:${item.sessionId}:${item.at}:${index}`)));
    for (const id of state.requestRows.keys()) if (!retained.has(id)) state.requestRows.delete(id);
    const shown = !filtered && !state.requestExpanded ? visible.slice(0, 5) : visible;
    const more = $("requests-more");
    if (more) { more.hidden = filtered || visible.length <= 5; more.textContent = state.requestExpanded ? "收起记录" : `查看全部 ${visible.length} 条记录`; more.setAttribute("aria-expanded", String(state.requestExpanded)); }
    const desired = shown.map((item) => {
      const id = String(item.id || `${item.model}:${item.sessionId}:${item.at}:${recent.indexOf(item)}`);
      let entry = state.requestRows.get(id);
      if (!entry) { entry = createRequestRow(); state.requestRows.set(id, entry); }
      const { model, session, time, badge, cost } = entry;
      const label = statusLabel(item.status);
      model.textContent = item.model || "未知模型"; model.title = model.textContent;
      session.textContent = item.sessionId ? `会话 ${item.sessionId}` : item.id ? `请求 ${item.id}` : "—"; session.title = session.textContent;
      const at = dateOf(item.at);
      time.textContent = at ? timeFormatter.format(at) : "—";
      time.title = at ? `${fullTimeFormatter.format(at)}（北京时间）` : "";
      badge.className = `request-status ${label.className}`; badge.textContent = label.label;
      cost.textContent = number(item.reservedUsd) > 0 && requestCategory(item.status) === "pending" ? `预留 ${percent(weeklyPercent(item.reservedUsd))}` : percent(weeklyPercent(item.costUsd));
      return entry.row;
    });
    if (!desired.length) desired.push(getEmptyRequestRow(filtered));
    const desiredSet = new Set(desired);
    Array.from(body.children).forEach((row) => { if (!desiredSet.has(row)) row.remove(); });
    desired.forEach((row, index) => { if (body.children[index] !== row) body.insertBefore(row, body.children[index] || null); });
  }

  function setTheme(theme, persist = true) {
    document.documentElement.dataset.theme = theme;
    document.body.toggleAttribute("data-ds-dark-theme", theme === "dark");
    const label = `切换为${theme === "dark" ? "浅色" : "深色"}模式`;
    for (const id of ["theme-toggle", "header-theme-toggle"]) {
      const button = $(id);
      if (!button) continue;
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", String(theme === "dark"));
      button.title = label;
    }
    if (persist) try { localStorage.setItem("dsh-quota-theme", theme); } catch { /* Theme remains available when browser storage is disabled. */ }
  }

  function openSettings() {
    if (!state.status || state.saving) { if (!state.status) showError("额度服务尚未连接，连接后即可管理设置。", true); return; }
    const config = state.status.config;
    $("enabled").checked = config.enabled !== false;
    $("five-hour-enabled").checked = config.fiveHourEnabled !== false;
    $("reservation-mode").value = config.reservationMode === "context" ? "context" : "request";
    $("output-reservation-tokens").value = number(config.outputReservationTokens, 2048);
    $("input-token-multiplier").value = number(config.inputTokenMultiplier, 1.25);
    $("auto-pricing-enabled").checked = config.autoPricingEnabled !== false;
    $("pricing-cny-per-usd").value = config.pricingCnyPerUsd ?? "";
    state.pricingRoutes = []; state.pricingAliases = [];
    $("pricing-routes").replaceChildren(); $("pricing-aliases").replaceChildren();
    $("pricing-provider-list").replaceChildren();
    for (const provider of state.status.providers || []) {
      const option = document.createElement("option"); option.value = provider.id; option.label = provider.name || provider.id;
      $("pricing-provider-list").append(option);
    }
    const providers = new Set([...Object.keys(config.pricingRoutes || {}), ...(state.status.providers || []).map((provider) => provider.id)]);
    for (const provider of providers) appendPricingRoute(provider, config.pricingRoutes?.[provider] || "");
    if (!providers.size) appendPricingRoute();
    for (const [requestId, model] of Object.entries(config.pricingModelAliases || {})) appendPricingAlias(requestId, model);
    $("settings-error").hidden = true;
    if ($("advanced-pricing")) $("advanced-pricing").open = false;
    state.pricingRows = [];
    $("pricing-body").replaceChildren();
    const models = new Map((state.status.pricingModels || []).map((model) => [model.id, model]));
    for (const id of Object.keys(config.modelRates || {})) if (!models.has(id)) models.set(id, { id, source: "自定义模型" });
    state.pricingModelList = [...models.values()].sort((a, b) => Number(!!config.modelRates?.[b.id]) - Number(!!config.modelRates?.[a.id]));
    state.pricingShown = 0;
    showMorePrices();
    if (!models.size) appendPricingRow(null);
    $("settings-dialog").showModal();
    renderPricingStatus();
  }

  function removeMapping(row, collection, entry) {
    const button = document.createElement("button"); button.type = "button"; button.className = "quiet-button remove-mapping";
    button.textContent = "×"; button.setAttribute("aria-label", "删除此项");
    button.addEventListener("click", () => { collection.splice(collection.indexOf(entry), 1); row.remove(); });
    row.append(button);
  }

  function mappingInput(placeholder, value = "") {
    const input = document.createElement("input"); input.type = "text"; input.placeholder = placeholder;
    input.value = value; input.maxLength = 256; input.setAttribute("aria-label", placeholder); return input;
  }

  function appendPricingRoute(provider = "", sourceId = "") {
    const row = document.createElement("div"); row.className = "pricing-mapping";
    const input = mappingInput("DSH 服务 ID", provider); input.maxLength = 200; input.setAttribute("list", "pricing-provider-list");
    const select = document.createElement("select"); select.setAttribute("aria-label", "该服务的价格来源");
    const manual = document.createElement("option"); manual.value = ""; manual.textContent = "仅手动单价"; select.append(manual);
    for (const source of state.status.pricing?.sources || []) {
      const option = document.createElement("option"); option.value = source.id;
      option.textContent = source.label + (source.supported ? "" : " · 尚未接入"); option.disabled = !source.supported; select.append(option);
    }
    select.value = sourceId;
    row.append(input, select);
    const entry = { input, select }; state.pricingRoutes.push(entry); removeMapping(row, state.pricingRoutes, entry);
    $("pricing-routes").append(row);
  }

  function appendPricingAlias(requestId = "", model = "") {
    const row = document.createElement("div"); row.className = "pricing-mapping";
    const input = mappingInput("完整服务/请求模型", requestId); const target = mappingInput("对应的目录型号", model);
    target.setAttribute("list", "pricing-catalog-models"); row.append(input, target);
    const entry = { input, target }; state.pricingAliases.push(entry); removeMapping(row, state.pricingAliases, entry);
    $("pricing-aliases").append(row);
  }

  function showMorePrices() {
    const end = Math.min(state.pricingShown + 40, state.pricingModelList.length);
    for (const model of state.pricingModelList.slice(state.pricingShown, end)) appendPricingRow(model, state.status.config.modelRates?.[model.id]);
    state.pricingShown = end;
    $("pricing-more").hidden = end >= state.pricingModelList.length;
    $("pricing-more").textContent = `显示更多模型（${end} / ${state.pricingModelList.length}）`;
  }

  function renderPricingStatus() {
    if (!$("settings-dialog").open) return;
    const pricing = state.status?.pricing || {};
    const sources = pricing.sources || [];
    const busy = state.syncingPrices || pricing.refreshing;
    $("sync-prices").disabled = busy || state.saving;
    $("save-settings").disabled = state.saving || state.syncingPrices;
    $("sync-prices").textContent = busy ? "正在同步…" : "立即同步";
    const bound = sources.filter((source) => source.bound);
    const ready = bound.filter((source) => source.state === "ready").length;
    setText("pricing-sync-status", pricing.cacheError || (busy ? "正在读取官方价格，完成后自动更新状态。" : !pricing.enabled ? "自动取价已关闭，现有手动配置继续生效。" : bound.length ? `已绑定 ${bound.length} 个来源，${ready} 个可用于记账。` : "选择来源并保存后开始自动取价。"));
    $("pricing-sources").replaceChildren();
    const labels = { idle: "待同步", refreshing: "同步中", ready: "可用", stale: "缓存已过期", error: "同步失败", "exchange-rate-required": "待设置汇率", "credentials-required": "尚未接入鉴权" };
    for (const source of sources) {
      const card = document.createElement("div"); card.className = "pricing-source"; card.dataset.state = source.state;
      const heading = document.createElement("div"); heading.className = "pricing-source-heading";
      const link = document.createElement("a"); link.textContent = source.label; link.href = source.url; link.target = "_blank"; link.rel = "noopener noreferrer";
      const badge = document.createElement("span"); badge.className = "pricing-source-state"; badge.textContent = `${labels[source.state] || source.state}${source.modelCount ? ` · ${source.modelCount} 个型号` : ""}`;
      heading.append(link, badge); card.append(heading);
      const note = document.createElement("p"); note.className = "pricing-source-note";
      const checked = dateOf(source.lastSuccessAt);
      note.textContent = source.error || (checked ? `最近成功：${fullTimeFormatter.format(checked)} · ${source.currency}` : source.supported ? `${source.currency} · 保存绑定后按需获取` : "接口需要独立凭据，本版本暂不使用。");
      if (source.state === "error" && checked) note.textContent += `；最近有效缓存：${fullTimeFormatter.format(checked)}`;
      card.append(note); $("pricing-sources").append(card);
    }
    const latest = new Map((state.status.pricingModels || []).map((model) => [model.id, model]));
    state.pricingModelList = state.pricingModelList.map((model) => latest.get(model.id) || {
      ...model, input: null, output: null, cacheRead: null, cacheWrite: null,
      available: false, waitingForExchangeRate: false, source: "暂无可用价格",
    });
    const existingIds = new Set(state.pricingModelList.map((model) => model.id));
    for (const model of latest.values()) if (!existingIds.has(model.id)) state.pricingModelList.push(model);
    for (const row of state.pricingRows) {
      if (!row.model || row.custom.checked) continue;
      const model = latest.get(row.model.id);
      row.source.textContent = model?.source || "暂无可用价格";
      row.source.title = [...(model?.notes || []), model?.checkedAt ? fullTimeFormatter.format(dateOf(model.checkedAt)) : ""].filter(Boolean).join("；");
      for (const [key, input] of Object.entries(row.inputs)) {
        input.value = model && model.available !== false && model[key] != null ? model[key] : "";
        input.placeholder = model?.waitingForExchangeRate ? "待汇率" : "待同步";
      }
    }
    if (state.pricingShown < Math.min(40, state.pricingModelList.length)) showMorePrices();
    $("pricing-more").hidden = state.pricingShown >= state.pricingModelList.length;
    $("pricing-more").textContent = `显示更多模型（${state.pricingShown} / ${state.pricingModelList.length}）`;
    $("pricing-catalog-models").replaceChildren();
    const seen = new Set();
    for (const model of latest.values()) {
      const separator = model.id.indexOf('/'); if (separator < 0) continue;
      const value = model.id.slice(separator + 1); if (seen.has(value)) continue; seen.add(value);
      const option = document.createElement("option"); option.value = value; $("pricing-catalog-models").append(option);
    }
  }

  async function syncPrices() {
    if (state.syncingPrices || state.saving || state.status?.pricing?.refreshing) return;
    const sourceIds = [...new Set(state.pricingRoutes.map((row) => row.select.value).filter(Boolean))];
    if (!sourceIds.length) { setText("settings-error", "请先选择至少一个服务的价格来源。"); $("settings-error").hidden = false; return; }
    const generation = ++state.generation;
    state.syncingPrices = true; renderPricingStatus();
    try {
      const status = validateStatus(await request("/api/pricing/refresh", { method: "POST", headers: { "Content-Type": "application/json", "X-DSH-Quota": "1" }, body: JSON.stringify({ sourceIds }) }));
      if (!state.pageActive || generation !== state.generation) return;
      state.status = status;
      render(state.status); toast("价格同步已开始，来源绑定在保存设置后生效");
    } catch (error) { setText("settings-error", safeMessage(error.message)); $("settings-error").hidden = false; }
    finally { state.syncingPrices = false; renderPricingStatus(); }
  }

  function appendPricingRow(model, override, { focus = false } = {}) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    let modelInput; let source;
    if (model) {
      const name = document.createElement("span"); name.className = "pricing-model-name"; name.textContent = model.id;
      source = document.createElement("span"); source.className = "pricing-model-source"; source.textContent = model.source || "服务价格";
      source.title = (model.notes || []).join("；");
      nameCell.append(name, source);
    } else {
      modelInput = document.createElement("input"); modelInput.type = "text"; modelInput.className = "model-name-input"; modelInput.placeholder = "模型 ID"; modelInput.setAttribute("aria-label", "新模型 ID"); modelInput.maxLength = 200;
      nameCell.append(modelInput);
    }
    row.append(nameCell);
    const inputs = {};
    const index = state.pricingRows.length;
    for (const [key, label] of [["input", "输入"], ["cacheRead", "缓存命中"], ["cacheWrite", "缓存写入"], ["output", "输出"]]) {
      const cell = document.createElement("td"); const input = document.createElement("input");
      const automaticRate = key === "cacheWrite" ? number(model?.cacheWrite, number(model?.input)) : number(model?.[key]);
      const overrideRate = key === "cacheWrite" ? number(override?.cacheWrite, number(override?.input, automaticRate)) : number(override?.[key], automaticRate);
      input.type = "number"; input.min = "0"; input.max = "1000000"; input.step = "any"; input.value = overrideRate; input.id = `price-${index}-${key}`; input.setAttribute("aria-label", `${model?.id || "新模型"} ${label}价格，美元每百万 tokens`);
      if (!override && model && (model.available === false || model[key] === null)) { input.value = ""; input.placeholder = model.waitingForExchangeRate ? "待汇率" : "待同步"; }
      input.disabled = !!model && !override; inputs[key] = input; cell.append(input); row.append(cell);
    }
    const toggleCell = document.createElement("td"); const custom = document.createElement("input"); custom.type = "checkbox"; custom.checked = !!override || !model; custom.setAttribute("aria-label", `为 ${model?.id || "新模型"} 使用自定义价格`);
    custom.addEventListener("change", () => { Object.values(inputs).forEach((input) => { input.disabled = !custom.checked; }); });
    toggleCell.append(custom); row.append(toggleCell); $("pricing-body").append(row);
    state.pricingRows.push({ model, modelInput, inputs, custom, source });
    if (!model && focus) {
      if ($("advanced-pricing")) $("advanced-pricing").open = true;
      modelInput.focus();
    }
  }

  function collectConfig() {
    const modelRates = { ...(state.status.config.modelRates || {}) };
    const seen = new Set();
    for (const row of state.pricingRows) {
      if (!row.custom.checked) { if (row.model) delete modelRates[row.model.id]; continue; }
      const id = (row.model?.id || row.modelInput.value).trim();
      if (!id) {
        if (!row.model && Object.values(row.inputs).every((input) => number(input.value) === 0)) continue;
        throw new Error("请为自定义价格填写模型 ID。");
      }
      if (seen.has(id) || (!row.model && Object.hasOwn(modelRates, id))) throw new Error(`模型 ${id} 的价格配置重复，请检查。`);
      seen.add(id);
      const rates = {};
      for (const [key, input] of Object.entries(row.inputs)) {
        if (!input.value.trim() || !input.checkValidity()) throw new Error(`模型 ${id} 的价格必须是非负数字。`);
        rates[key] = number(input.value);
      }
      Object.defineProperty(modelRates, id, { value: rates, enumerable: true, configurable: true, writable: true });
    }
    const pricingRoutes = {};
    for (const row of state.pricingRoutes) {
      const provider = row.input.value.trim(); const source = row.select.value;
      if (!source && !provider) continue;
      if (source && !provider) throw new Error("请选择价格来源对应的 DSH 服务 ID。");
      if (!source) continue;
      if (Object.hasOwn(pricingRoutes, provider)) throw new Error(`服务 ${provider} 的来源绑定重复。`);
      Object.defineProperty(pricingRoutes, provider, { value: source, enumerable: true });
    }
    const pricingModelAliases = {};
    for (const row of state.pricingAliases) {
      const id = row.input.value.trim(); const model = row.target.value.trim();
      if (!id && !model) continue;
      if (!id || !model || Object.hasOwn(pricingModelAliases, id)) throw new Error("请补全型号映射并移除重复项。");
      Object.defineProperty(pricingModelAliases, id, { value: model, enumerable: true });
    }
    const exchange = $("pricing-cny-per-usd");
    if (exchange.value.trim() && !exchange.checkValidity()) throw new Error("请输入有效的人民币换算汇率。");
    return {
      fiveHourLimitUsd: number(state.status.config.fiveHourLimitUsd, 4),
      weeklyLimitUsd: number(state.status.config.weeklyLimitUsd, 20),
      enabled: $("enabled").checked,
      fiveHourEnabled: $("five-hour-enabled").checked,
      reservationMode: $("reservation-mode").value,
      outputReservationTokens: number($("output-reservation-tokens").value),
      inputTokenMultiplier: number($("input-token-multiplier").value),
      modelRates,
      autoPricingEnabled: $("auto-pricing-enabled").checked,
      pricingCnyPerUsd: exchange.value.trim() ? number(exchange.value) : null,
      pricingRoutes, pricingModelAliases,
    };
  }

  function setSaving(saving) {
    state.saving = saving;
    if (saving) state.generation += 1;
    for (const id of ["save-settings", "cancel-settings", "close-settings", "add-model", "add-pricing-route", "add-pricing-alias", "pricing-more"]) $(id).disabled = saving;
    $("settings-form").querySelectorAll("input, select, .remove-mapping").forEach((input) => {
      if (saving) { input.dataset.wasDisabled = String(input.disabled); input.disabled = true; }
      else { input.disabled = input.dataset.wasDisabled === "true"; delete input.dataset.wasDisabled; }
    });
    setText("save-settings", saving ? "正在保存…" : "保存设置");
    $("settings-form").setAttribute("aria-busy", String(saving));
    setBusy();
    renderPricingStatus();
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (state.saving || state.syncingPrices) return;
    $("settings-error").hidden = true;
    let config;
    try { config = collectConfig(); } catch (error) {
      setText("settings-error", safeMessage(error.message)); $("settings-error").hidden = false;
      if ($("advanced-pricing")) $("advanced-pricing").open = true;
      return;
    }
    setSaving(true);
    try {
      const status = validateStatus(await request("/api/config", { method: "POST", headers: { "Content-Type": "application/json", "X-DSH-Quota": "1" }, body: JSON.stringify(config) }));
      if (!state.pageActive) return;
      state.status = status;
      state.actionError = null;
      $("error-banner").hidden = true;
      render(status);
      setConnection(true);
      $("settings-dialog").close();
      toast("设置已保存，历史用量继续保留");
    } catch (error) {
      if (!state.pageActive) return;
      setText("settings-error", safeMessage(error.message)); $("settings-error").hidden = false;
    } finally { setSaving(false); }
  }

  let savedTheme;
  const pageParameters = new URLSearchParams(window.location.search);
  const embedded = pageParameters.get("embedded") === "1";
  if (embedded) document.documentElement.dataset.embedded = "true";
  try { savedTheme = localStorage.getItem("dsh-quota-theme"); } catch { savedTheme = null; }
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  setTheme(savedTheme === "light" || savedTheme === "dark" ? savedTheme : systemTheme.matches ? "dark" : "light", false);
  const requestedTheme = pageParameters.get("theme");
  if (requestedTheme === "dark" || requestedTheme === "light") setTheme(requestedTheme, false);
  let parentThemeObserver = null;
  let parentBody = null;
  const syncParentTheme = () => {
    if (parentBody) setTheme(parentBody.hasAttribute("data-ds-dark-theme") ? "dark" : "light", false);
  };
  if (embedded && window.parent !== window) {
    try {
      parentBody = window.parent.document.body;
      syncParentTheme();
      parentThemeObserver = new MutationObserver(syncParentTheme);
      parentThemeObserver.observe(parentBody, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
    } catch { /* A cross-origin parent can provide the theme query parameter or a checked message. */ }
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent || event.origin !== window.location.origin || event.data?.type !== "dsh-quota-theme") return;
      if (event.data.theme === "dark" || event.data.theme === "light") setTheme(event.data.theme, false);
    });
  }
  for (const id of ["theme-toggle", "header-theme-toggle"]) $(id)?.addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", !embedded));
  $("requests-more")?.addEventListener("click", () => { state.requestExpanded = !state.requestExpanded; renderRequests(state.status?.recent || []); });
  $("refresh-button").addEventListener("click", () => refresh({ manual: true }));
  $("dismiss-error").addEventListener("click", () => { state.actionError = null; $("error-banner").hidden = true; });
  $("open-settings").addEventListener("click", openSettings);
  $("sidebar-settings").addEventListener("click", openSettings);
  $("close-settings").addEventListener("click", () => { if (!state.saving) $("settings-dialog").close(); });
  $("cancel-settings").addEventListener("click", () => { if (!state.saving) $("settings-dialog").close(); });
  $("settings-dialog").addEventListener("cancel", (event) => { if (state.saving) event.preventDefault(); });
  $("settings-form").addEventListener("submit", saveSettings);
  $("add-model").addEventListener("click", () => appendPricingRow(null, undefined, { focus: true }));
  $("add-pricing-route").addEventListener("click", () => appendPricingRoute());
  $("add-pricing-alias").addEventListener("click", () => appendPricingAlias());
  $("sync-prices").addEventListener("click", syncPrices);
  $("pricing-more").addEventListener("click", showMorePrices);
  $("request-search")?.addEventListener("input", (event) => {
    state.requestSearch = event.target.value;
    renderRequests(state.status?.recent || []);
  });
  $("request-filter")?.addEventListener("change", (event) => {
    const value = event.target.value;
    state.requestFilter = ["all", "completed", "pending", "failed", "estimated"].includes(value) ? value : "all";
    renderRequests(state.status?.recent || []);
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { updateCountdowns(); refresh(); } });
  let pollTimer;
  let countdownTimer;
  function startTimers() {
    clearInterval(pollTimer); clearInterval(countdownTimer);
    pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
    countdownTimer = setInterval(() => { if (!document.hidden) updateCountdowns(); }, 1000);
  }
  window.addEventListener("pagehide", () => {
    state.pageActive = false;
    parentThemeObserver?.disconnect();
    clearInterval(pollTimer); clearInterval(countdownTimer); clearTimeout(state.toastTimer);
    requestControllers.forEach((controller) => controller.abort());
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    state.pageActive = true;
    if (parentThemeObserver && parentBody) parentThemeObserver.observe(parentBody, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
    syncParentTheme(); startTimers(); updateCountdowns(); refresh();
  });
  startTimers();
  refresh();
})();
