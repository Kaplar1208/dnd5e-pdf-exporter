import { buildCanonicalData } from "./actor-mapper.js";
import { fillPdf } from "./pdf-filler.js";

const MODULE_ID = "dnd5e-pdf-multilang-exporter";

/** Idiomas disponibles = subcarpetas de templates/ que tengan sheet.pdf + fieldmap.json */
async function getAvailableLanguages() {
  // Lista fija por ahora; si quieres detectarlo dinámicamente puedes usar
  // FilePicker.browse("data", `modules/${MODULE_ID}/templates`) — requiere
  // permisos de FilePicker en el mundo.
  return ["en", "es"];
}

async function loadTemplateAndMap(lang) {
  const base = `modules/${MODULE_ID}/templates/${lang}`;
  const [pdfRes, mapRes] = await Promise.all([
    fetch(`${base}/sheet.pdf`),
    fetch(`${base}/fieldmap.json`)
  ]);
  if (!pdfRes.ok || !mapRes.ok) return null;
  const pdfBytes = new Uint8Array(await pdfRes.arrayBuffer());
  const fieldMap = await mapRes.json();
  return { pdfBytes, fieldMap };
}

/**
 * Lee del DOM de la hoja YA ABIERTA (la misma desde donde se le dio clic a
 * "Exportar PDF") el nombre que se está mostrando ahora mismo para cada
 * item, y arma un mapa id -> nombre visible.
 *
 * Esto captura gratis CUALQUIER traducción ya aplicada en pantalla, sin
 * importar de dónde venga: Babele, el idioma nativo de Foundry, o una
 * extensión de traducción del navegador (ej. Google Translate) — no
 * necesitamos saber cuál de las tres es ni cómo funciona por dentro.
 *
 * Limitación conocida: solo captura items que están renderizados como fila
 * en el DOM ahora mismo. Objetos guardados dentro de un contenedor cerrado
 * (mochila, bolsa) no aparecen — esos caen al respaldo del glosario manual
 * o al nombre en inglés (ver actor-mapper.js).
 */
function scanNameOverridesFromSheet(sheetApp) {
  const map = new Map();
  const root = sheetApp?.element instanceof HTMLElement ? sheetApp.element
    : (sheetApp?.element?.[0] instanceof HTMLElement ? sheetApp.element[0] : null);
  if (!root) return map;

  const NAME_SELECTORS = [
    ".name-stacked .title",   // hoja nueva de dnd5e (ApplicationV2)
    ".item-name .title",
    ".item-name h4",
    ".item-name",
    "h4.item-name",
    "h4"
  ];

  for (const el of root.querySelectorAll("[data-item-id]")) {
    const id = el.dataset.itemId;
    if (!id || map.has(id)) continue;

    let text = "";
    for (const sel of NAME_SELECTORS) {
      const nameEl = el.querySelector(sel);
      // .textContent aplana cualquier <font> anidado que inyecte Google
      // Translate u otra extensión, dejando solo el texto visible real.
      const candidate = nameEl?.textContent?.trim();
      if (candidate) { text = candidate; break; }
    }
    if (text) map.set(id, text);
  }

  console.log(`dnd5e-pdf-multilang-exporter | nombres capturados del DOM de la hoja: ${map.size}`);
  return map;
}

/**
 * Convierte el HTML interno de un <p> (con <br> y tags <font> de Google
 * Translate) a texto plano con saltos de línea preservados.
 */
function extractParagraphText(pEl) {
  if (!pEl) return "";
  return pEl.innerHTML
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .split("\n").map(l => l.trim()).filter(Boolean).join("\n")
    .trim();
}

/**
 * Lee del DOM los 4 cuadros de personalidad (Rasgos/Ideales/Vínculos/
 * Defectos) de la pestaña de biografía. Se identifican por el ÍCONO de
 * cada cuadro (fa-puzzle-piece, fa-seedling, fa-link, fa-heart-crack), NO
 * por el texto del título — ese texto puede venir mal traducido (ej.
 * Google Translate convirtió "Bonds" en "Cautiverio"), pero el ícono es
 * siempre el mismo sin importar el idioma.
 */
function scanBiographyOverridesFromSheet(sheetApp) {
  const result = {};
  const root = sheetApp?.element instanceof HTMLElement ? sheetApp.element
    : (sheetApp?.element?.[0] instanceof HTMLElement ? sheetApp.element[0] : null);
  if (!root) return result;

  const bioTab = root.querySelector('[data-tab="biography"][data-application-part]');
  if (!bioTab) return result;

  const ICON_MAP = {
    "fa-puzzle-piece": "personalityTraits",
    "fa-seedling": "ideals",
    "fa-link": "bonds",
    "fa-heart-crack": "flaws"
  };

  for (const box of bioTab.querySelectorAll(".textbox.textbox-half")) {
    const icon = box.querySelector("h3 i");
    const iconClass = Object.keys(ICON_MAP).find(cls => icon?.classList.contains(cls));
    if (!iconClass) continue;
    result[ICON_MAP[iconClass]] = extractParagraphText(box.querySelector("p"));
  }
  return result;
}

async function exportActorToPdf(actor, lang, sheetApp) {
  const loaded = await loadTemplateAndMap(lang);
  if (!loaded) {
    ui.notifications.error(game.i18n.format("PDFEXPORT.NoTemplate", { lang }));
    return;
  }

  const domNames = scanNameOverridesFromSheet(sheetApp);
  const bioOverrides = scanBiographyOverridesFromSheet(sheetApp);
  const canonicalData = await buildCanonicalData(actor, lang, domNames, bioOverrides);
  const outBytes = await fillPdf(loaded.pdfBytes, loaded.fieldMap, canonicalData);

  const blob = new Blob([outBytes], { type: "application/pdf" });
  const filename = `${actor.name.replace(/\s+/g, "_")}_${lang}.pdf`;
  saveDataToFile(blob, "application/pdf", filename); // helper global de Foundry
  ui.notifications.info(game.i18n.localize("PDFEXPORT.Success"));
}

async function openExportDialog(actor, sheetApp) {
  const languages = await getAvailableLanguages();
  const options = languages.map(l => `<option value="${l}">${l.toUpperCase()}</option>`).join("");

  new Dialog({
    title: game.i18n.localize("PDFEXPORT.DialogTitle"),
    content: `
      <div class="form-group">
        <label>${game.i18n.localize("PDFEXPORT.LanguageField")}</label>
        <select id="pdfexport-lang">${options}</select>
      </div>
    `,
    buttons: {
      export: {
        label: game.i18n.localize("PDFEXPORT.ExportButton"),
        callback: async html => {
          const lang = html.find("#pdfexport-lang").val();
          try {
            await exportActorToPdf(actor, lang, sheetApp);
          } catch (err) {
            console.error("dnd5e-pdf-multilang-exporter |", err);
            ui.notifications.error(game.i18n.localize("PDFEXPORT.Error"));
          }
        }
      },
      cancel: { label: game.i18n.localize("PDFEXPORT.CancelButton") }
    },
    default: "export"
  }).render(true);
}

Hooks.once("init", () => {
  console.log("dnd5e-pdf-multilang-exporter | init");
});

/**
 * dnd5e v4+ usa hojas ApplicationV2 (ej. "CharacterActorSheet"), donde el
 * hook clásico `getActorSheetHeaderButtons` ya NO se dispara. En su lugar,
 * escuchamos el render de la hoja e inyectamos el botón directamente en el
 * DOM de la cabecera de la ventana.
 *
 * Si tu Foundry/dnd5e usa otro nombre de clase de hoja (verifícalo con
 * `game.actors.getName("Bane").sheet.constructor.name` en consola), añade
 * ese nombre al array SHEET_HOOKS de abajo.
 */
const SHEET_HOOKS = ["renderCharacterActorSheet", "renderActorSheet5eCharacter", "renderActorSheet5eCharacter2"];

function injectHeaderButton(app, htmlOrRoot) {
  const root = htmlOrRoot instanceof HTMLElement ? htmlOrRoot
    : (htmlOrRoot?.[0] instanceof HTMLElement ? htmlOrRoot[0] : app.element);
  if (!root) return;

  const header = root.closest(".application")?.querySelector(".window-header")
    ?? root.querySelector(".window-header");
  if (!header || header.querySelector(".pdf-export-btn")) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "header-control pdf-export-btn";
  btn.dataset.tooltip = game.i18n.localize("PDFEXPORT.ButtonLabel");
  btn.innerHTML = `<i class="fas fa-file-pdf"></i>`;
  btn.addEventListener("click", ev => {
    ev.preventDefault();
    ev.stopPropagation();
    openExportDialog(app.actor ?? app.document, app);
  });

  // Insertarlo antes del botón de cerrar si existe, si no, al final.
  const closeBtn = header.querySelector('[data-action="close"], .close, .header-control.icon.fa-times')?.closest("button, a");
  if (closeBtn) closeBtn.before(btn); else header.appendChild(btn);
}

for (const hookName of SHEET_HOOKS) {
  Hooks.on(hookName, (app, html) => injectHeaderButton(app, html));
}

// Compatibilidad con hojas del framework viejo (Application v1), por si tu
// mundo aún las usa para algún tipo de actor.
Hooks.on("getActorSheetHeaderButtons", (sheet, buttons) => {
  if (sheet.actor.type !== "character") return;
  buttons.unshift({
    label: game.i18n.localize("PDFEXPORT.ButtonLabel"),
    class: "pdf-export",
    icon: "fas fa-file-pdf",
    onclick: () => openExportDialog(sheet.actor, sheet)
  });
});
