/**
 * translation-loader.js
 *
 * Foundry's game.i18n only exposes strings for the WORLD'S currently active
 * language. To export a sheet in a language different from the one the table
 * is actually playing in, we fetch the raw lang JSON files for the requested
 * language directly (core + system + this module) and build our own flat
 * lookup, independent of game.i18n.lang.
 *
 * This is what makes "add a new language later" possible without touching
 * any other file: drop lang/xx.json into the system/module and it just works.
 */

const _cache = new Map(); // lang -> flattened dict

/** Flatten a nested translations object into dot.notation keys, Foundry-style. */
function _flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) _flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

async function _fetchJson(path) {
  try {
    const res = await fetch(path);
    if (!res.ok) return {}; // 404 es normal: no todos los paquetes traen ese idioma
    return await res.json();
  } catch (err) {
    console.warn(`dnd5e-pdf-multilang-exporter | error de red al pedir ${path}`, err);
    return {};
  }
}

/**
 * El campo `path` de un objeto de idioma puede venir ya como ruta completa
 * desde la raíz ("systems/dnd5e/lang/en.json") o relativa a la carpeta del
 * propio paquete ("lang/en.json"), según la versión/autor del manifest.
 * Si ya trae el prefijo "systems/" o "modules/", se usa tal cual; si no,
 * se le antepone. Esto evita rutas duplicadas como
 * "modules/x/modules/x/lang/en.json" (bug real visto en consola).
 */
function _resolveLangPath(prefix, path) {
  return path.startsWith("systems/") || path.startsWith("modules/") ? path : `${prefix}/${path}`;
}

/**
 * Load (and cache) the merged translation dictionary for a given language code,
 * pulling from Foundry core, the active system (dnd5e), and this module —
 * mirroring the same merge order Foundry itself uses when it boots a language.
 */
export async function getTranslations(lang) {
  if (_cache.has(lang)) return _cache.get(lang);

  const sources = [];

  // Core Foundry language file (only a handful of langs ship this by default).
  sources.push(`lang/${lang}.json`);

  // The active game system's language file (this is where ability/skill/
  // condition/damage-type names actually live for dnd5e).
  const system = game.system;
  const systemLangEntry = system?.languages?.find(l => l.lang === lang);
  if (systemLangEntry) sources.push(_resolveLangPath(`systems/${system.id}`, systemLangEntry.path));

  // Any active modules that ship a translation for this lang (e.g. a
  // community Spanish translation module for dnd5e, if that's what's used
  // instead of/alongside the system's own).
  for (const mod of game.modules) {
    if (!mod.active) continue;
    const entry = mod.languages?.find(l => l.lang === lang);
    if (entry) sources.push(_resolveLangPath(`modules/${mod.id}`, entry.path));
  }

  // This module's own UI strings, so {{PDFEXPORT.*}} keys resolve too if ever needed.
  sources.push(`modules/dnd5e-pdf-multilang-exporter/lang/${lang}.json`);

  const jsons = await Promise.all(sources.map(_fetchJson));
  const merged = jsons.reduce((acc, j) => Object.assign(acc, _flatten(j)), {});

  _cache.set(lang, merged);
  return merged;
}

/**
 * Localize a key against a specific (possibly non-active) language dict,
 * with the same {{placeholder}} substitution Foundry's own localize() does.
 */
export function localizeIn(dict, key, data = {}) {
  let str = dict[key] ?? key;
  for (const [k, v] of Object.entries(data)) {
    str = str.replaceAll(`{${k}}`, v);
  }
  return str;
}

// ---------------------------------------------------------------------
// Glosario manual (scripts/glossary.json)
//
// game.i18n / CONFIG.DND5E cubren términos de reglas (habilidades,
// escuelas de conjuro, tipos de daño...), pero NO nombres propios de items
// concretos (el hechizo "Hunter's Mark", la dote "Sentinel", etc.) — esos
// dependen de que el actor tenga compendios traducidos (ej. vía Babele).
// Este glosario es un respaldo manual, independiente de si Babele está
// instalado o funcionando, para esos nombres puntuales de Bane.
// ---------------------------------------------------------------------

let _glossaryPromise = null;

async function _loadGlossary() {
  if (!_glossaryPromise) {
    _glossaryPromise = fetch(`modules/dnd5e-pdf-multilang-exporter/scripts/glossary.json`)
      .then(res => res.ok ? res.json() : {})
      .catch(() => ({}));
  }
  return _glossaryPromise;
}

/**
 * Busca `name` en el glosario para el idioma y categoría dados.
 * Devuelve la traducción si existe, o `name` tal cual si no hay entrada
 * (nunca falla ni deja el campo vacío).
 *
 * @param {string} lang      "es", "en", ...
 * @param {string} category  "spells" | "classFeatures" | "feats" | "raceFeatures" | "equipment" | "misc"
 * @param {string} name      nombre en inglés tal como está en el item de Foundry
 */
export async function glossaryLookup(lang, category, name) {
  if (!name) return name;
  const glossary = await _loadGlossary();
  return glossary[lang]?.[category]?.[name] ?? name;
}

/** Igual que glossaryLookup, pero probando varias categorías en orden hasta encontrar una coincidencia. */
export async function glossaryLookupAny(lang, categories, name) {
  if (!name) return name;
  const glossary = await _loadGlossary();
  for (const cat of categories) {
    const hit = glossary[lang]?.[cat]?.[name];
    if (hit) return hit;
  }
  return name;
}
