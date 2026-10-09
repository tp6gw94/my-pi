import { COORDINATION_LIMITS, DEFAULT_EXECUTION_TOOLS, WEB_LOADER_TOOL_NAME, normalizeTools } from "./coordination.mjs";

const signedEntryPattern = /^([+-])([A-Za-z_][A-Za-z0-9_.:-]*)$/;
const knownExecutionNames = new Set([...DEFAULT_EXECUTION_TOOLS, "grep", "find", "ls"]);

function literalName(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > COORDINATION_LIMITS.maxToolNameChars ||
    value.includes("\0") || /\s/.test(value)) {
    throw new Error("tools entries must be literal tool names");
  }
  return value;
}

function selectedName(value) {
  const name = value[0] === "+" || value[0] === "-" ? value.slice(1) : value;
  normalizeTools([name]);
  if (name === WEB_LOADER_TOOL_NAME) {
    throw new Error(`${WEB_LOADER_TOOL_NAME} is activation machinery; name a functional web tool such as web_search or fetch_content instead`);
  }
  return name;
}

export function parseToolExpression(value) {
  if (value === undefined) return { form: "omitted" };
  if (!Array.isArray(value) || value.length > COORDINATION_LIMITS.maxTools) {
    throw new Error(`tools must be an array of at most ${COORDINATION_LIMITS.maxTools} names`);
  }
  if (value.length === 0) return { form: "replace", names: [] };
  const forms = new Set();
  for (const entry of value) {
    const name = literalName(entry);
    if (name === "+" || name === "-") throw new Error("tools entries must be literal tool names");
    forms.add(name[0] === "+" || name[0] === "-" ? "adjust" : "replace");
  }
  if (forms.size > 1) throw new Error("tools must be all plain replacement names or all +name/-name adjustments, never mixed");

  if (forms.has("adjust")) {
    const ops = value.map((entry) => {
      const signed = signedEntryPattern.exec(entry);
      if (!signed) throw new Error(`Invalid tools entry: ${entry}`);
      return { op: signed[1] === "+" ? "add" : "remove", name: selectedName(entry) };
    });
    return { form: "adjust", ops };
  }

  const names = value.map((entry) => selectedName(entry));
  const seen = new Set();
  for (const name of names) {
    if (seen.has(name)) throw new Error(`tools contains duplicate tool ${name}`);
    seen.add(name);
  }
  return { form: "replace", names };
}

function assertNoOverlap(tools, webTools) {
  const overlap = tools.filter((name) => webTools.includes(name));
  if (overlap.length) throw new Error(`Tool ${overlap[0]} cannot be both an execution tool and a web tool`);
}

function enabledName(catalog, name) {
  if (!catalog.enabled.includes(name)) {
    throw new Error(`Web tool ${name} is disabled or renamed in the installed pi-web-access configuration`);
  }
  return name;
}

function slotForName(catalog, name) {
  const slot = catalog.slots.find((entry) => entry.name === name);
  if (!slot || !catalog.enabled.includes(name)) {
    throw new Error(`Web tool ${name} is disabled or renamed in the installed pi-web-access configuration`);
  }
  return slot;
}

function bindSlots(catalog, webTools) {
  return Object.fromEntries(webTools.map((name) => [name, slotForName(catalog, name).key]));
}

function validateBoundSlots(catalog, webTools, slots) {
  if (!slots || typeof slots !== "object" || Array.isArray(slots) || Object.getPrototypeOf(slots) !== Object.prototype) {
    throw new Error("webToolSlots must map selected web tools to installed slot keys");
  }
  const provided = Object.keys(slots).sort();
  const expected = [...webTools].sort();
  if (provided.length !== expected.length || provided.some((key, index) => key !== expected[index])) {
    throw new Error("webToolSlots must exactly match the selected web tools");
  }
  return Object.fromEntries(webTools.map((name) => {
    const slot = slotForName(catalog, name);
    if (slot.key !== slots[name]) {
      throw new Error(`Web tool ${name} no longer matches installed slot ${slots[name]}; rename or reassignment rejected`);
    }
    return [name, slot.key];
  }));
}

function expressionNeedsCatalog(expression, webAccess) {
  if (expression.form === "omitted") return webAccess !== false;
  if (webAccess === true) return true;
  const names = expression.form === "replace" ? expression.names : expression.ops.map((op) => op.name);
  return names.some((name) => !knownExecutionNames.has(name));
}

export function resolveTaskCapabilities(input, readCatalog) {
  const loadCatalog = () => {
    if (typeof readCatalog !== "function") throw new Error("Web tool selection requires the installed pi-web-access configuration");
    return readCatalog();
  };
  if (input.webTools !== undefined) {
    if (input.tools === undefined) throw new Error("Resolved web selections require an explicit tools array");
    const tools = normalizeTools(input.tools);
    const webTools = normalizeTools(input.webTools);

    if (webTools.length > COORDINATION_LIMITS.maxWebTools) throw new Error(`Resolved web tools exceed ${COORDINATION_LIMITS.maxWebTools} names`);
    if (webTools.includes(WEB_LOADER_TOOL_NAME)) throw new Error(`${WEB_LOADER_TOOL_NAME} is activation machinery, not a selected web tool`);
    if (input.webAccess !== undefined && (typeof input.webAccess !== "boolean" || input.webAccess !== (webTools.length > 0))) {
      throw new Error("webAccess contradicts the resolved web tool selection");
    }
    assertNoOverlap(tools, webTools);

    if (webTools.length === 0) {
      if (input.webToolSlots !== undefined && Object.keys(input.webToolSlots).length > 0) throw new Error("webToolSlots requires selected web tools");
      return { tools, webTools, webAccess: false };
    }

    const webToolSlots = input.webToolSlots === undefined
      ? bindSlots(loadCatalog(), webTools)
      : validateBoundSlots(loadCatalog(), webTools, input.webToolSlots);
    return { tools, webTools, webAccess: true, webToolSlots };
  }
  if (input.webAccess !== undefined && typeof input.webAccess !== "boolean") throw new Error("webAccess must be boolean");
  const expression = parseToolExpression(input.tools);
  const execution = new Set(expression.form === "replace" ? [] : DEFAULT_EXECUTION_TOOLS);
  let operations = [];
  if (expression.form === "replace") operations = expression.names.map((name) => ({ op: "add", name }));
  else if (expression.form === "adjust") operations = expression.ops;

  if (!expressionNeedsCatalog(expression, input.webAccess)) {
    for (const { op, name } of operations) {
      if (op === "add") execution.add(name);
      else execution.delete(name);
    }
    const tools = [...execution];
    if (tools.length > COORDINATION_LIMITS.maxTools) throw new Error(`Resolved execution tools exceed ${COORDINATION_LIMITS.maxTools} names`);
    return { tools, webTools: [], webAccess: false };
  }

  const catalog = loadCatalog();
  const selected = new Set();
  const apply = (op, name) => {
    if (catalog.reserved.has(name)) {
      if (op === "remove") selected.delete(name);
      else selected.add(enabledName(catalog, name));
      return;
    }
    if (op === "add") execution.add(name);
    else execution.delete(name);
  };
  for (const { op, name } of operations) apply(op, name);

  const family = [...catalog.enabled];
  const selectedFamilyTools = family.filter((name) => selected.has(name));
  const familyRequested = expression.form === "omitted" ? input.webAccess !== false : input.webAccess === true;
  if (familyRequested && family.length === 0) throw new Error("Web access requested but all installed web tools are disabled");

  let webTools;
  if (expression.form === "omitted") webTools = input.webAccess === false ? [] : family;
  else if (selectedFamilyTools.length === 0) webTools = input.webAccess === true ? family : [];
  else if (input.webAccess === false) throw new Error(`webAccess false contradicts the selected web tools: ${selectedFamilyTools.join(", ")}`);
  else if (input.webAccess === true) {
    if (selectedFamilyTools.length !== family.length) {
      throw new Error(`webAccess true contradicts the selected web subset: ${selectedFamilyTools.join(", ")}; omit webAccess or name every enabled web tool`);
    }
    webTools = family;
  } else webTools = selectedFamilyTools;
  if (webTools.length > COORDINATION_LIMITS.maxWebTools) throw new Error(`Resolved web tools exceed ${COORDINATION_LIMITS.maxWebTools} names`);

  const tools = [...execution];
  if (tools.length > COORDINATION_LIMITS.maxTools) throw new Error(`Resolved execution tools exceed ${COORDINATION_LIMITS.maxTools} names`);
  assertNoOverlap(tools, webTools);
  return { tools, webTools, webAccess: webTools.length > 0,
    ...(webTools.length > 0 ? { webToolSlots: bindSlots(catalog, webTools) } : {}) };
}

export function resolveWebLaunch(spec, catalog) {
  const collision = spec.tools.find((name) => catalog.reserved.has(name));
  if (collision) throw new Error(`Execution tool ${collision} collides with an installed pi-web-access name`);
  if (spec.webTools.length === 0) return undefined;
  if (catalog.enabled.length === 0) throw new Error("Web access requested but all installed web tools are disabled");
  if (spec.webToolSlots !== undefined) validateBoundSlots(catalog, spec.webTools, spec.webToolSlots);

  const functional = spec.webTools.map((name) => {
    const slot = slotForName(catalog, name);
    return { key: slot.key, name, label: slot.label };
  });
  const loader = catalog.mode !== "eager";
  return {
    functional,
    family: [...catalog.enabled],
    loader,
    approved: [...functional.map((entry) => entry.name), ...(loader ? [WEB_LOADER_TOOL_NAME] : [])],
  };
}
