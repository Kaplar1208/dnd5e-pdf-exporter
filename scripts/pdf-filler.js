/**
 * pdf-filler.js
 *
 * Toma:
 *  - los bytes de una plantilla PDF rellenable (templates/<lang>/sheet.pdf)
 *  - un fieldmap.json que dice "esta clave canónica va en este campo del PDF"
 *  - los datos canónicos del actor (ver actor-mapper.js)
 *
 * y devuelve los bytes del PDF ya relleno, listo para descargar.
 *
 * Requiere pdf-lib. Colócalo en scripts/lib/pdf-lib.min.js (build UMD) y
 * cárgalo como script normal en module.json, o impórtalo como ES module si
 * usas una build .mjs. No lo he incluido aquí porque es una librería de
 * terceros (~700kb) que debes descargar tú: https://pdf-lib.js.org
 */

/**
 * Cuenta cuántas líneas ocuparía `text` al envolverse a un ancho máximo
 * `maxWidth` con la fuente y tamaño dados (respeta los saltos de línea "\n"
 * ya presentes en el texto, y además envuelve líneas largas por palabra).
 */
function countWrappedLines(font, text, size, maxWidth) {
  const paragraphs = text.split("\n");
  let totalLines = 0;
  for (const para of paragraphs) {
    if (para === "") { totalLines += 1; continue; }
    const words = para.split(" ");
    let line = "";
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(test, size) > maxWidth) {
        totalLines += 1;
        line = word;
      } else {
        line = test;
      }
    }
    if (line) totalLines += 1;
  }
  return totalLines;
}

/**
 * Elige el tamaño de fuente más grande (dentro de [minSize,maxSize]) que
 * hace que `text` quepa dentro de una caja de `boxWidth`x`boxHeight` puntos.
 * Esto reemplaza al "autoajuste" nativo del PDF (fontSize=0), que muchos
 * visores (ej. el visor de PDF integrado de Chrome) no manejan bien y en
 * vez de encoger el texto lo agrandan.
 */
function fitFontSize(font, text, boxWidth, boxHeight, { maxSize = 9, minSize = 5, padding = 3 } = {}) {
  const usableW = Math.max(boxWidth - padding * 2, 10);
  const usableH = Math.max(boxHeight - padding * 2, 8);
  for (let size = maxSize; size >= minSize; size -= 0.5) {
    const lineHeight = size * 1.15;
    const lines = countWrappedLines(font, text, size, usableW);
    if (lines * lineHeight <= usableH) return size;
  }
  return minSize;
}

/**
 * Convierte cualquier imagen (webp/jpg/png/...) a bytes PNG usando un canvas,
 * porque pdf-lib solo puede incrustar directamente PNG o JPEG — y el
 * retrato de un actor de Foundry suele ser .webp.
 */
async function urlToPngBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch del retrato falló: HTTP ${res.status} en ${url}`);
  const blob = await res.blob();
  if (blob.type === "image/png" || blob.type === "image/jpeg") {
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type };
  }
  if (blob.type === "image/svg+xml" || url.toLowerCase().endsWith(".svg")) {
    throw new Error("el retrato es un SVG (ej. el ícono por defecto de Foundry); usa una imagen PNG/JPG/WEBP real como retrato del actor");
  }
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  return { bytes: new Uint8Array(await pngBlob.arrayBuffer()), type: "image/png" };
}

/**
 * Incrusta el retrato del actor en el PDF si el fieldmap define una clave
 * especial "_portrait": { page: N (1-indexado), rect: [x0,y0,x1,y1] en
 * coordenadas nativas del PDF (y hacia arriba) }. Mantiene proporción y
 * centra la imagen dentro del recuadro (contain-fit).
 */
async function embedPortrait(pdfDoc, fieldMap, canonicalData) {
  const spec = fieldMap._portrait;
  const url = canonicalData.meta?.portraitUrl;
  console.log("dnd5e-pdf-exporter | intentando incrustar retrato:", url);
  if (!spec) { console.log("dnd5e-pdf-exporter | fieldmap no define _portrait, se omite"); return; }
  if (!url) { console.log("dnd5e-pdf-exporter | el actor no tiene actor.img, se omite retrato"); return; }

  try {
    const { bytes, type } = await urlToPngBytes(url);
    const image = type === "image/jpeg" ? await pdfDoc.embedJpg(bytes) : await pdfDoc.embedPng(bytes);
    const page = pdfDoc.getPages()[spec.page - 1];
    const [x0, y0, x1, y1] = spec.rect;
    const boxW = x1 - x0, boxH = y1 - y0;
    const scale = Math.min(boxW / image.width, boxH / image.height);
    const w = image.width * scale, h = image.height * scale;
    page.drawImage(image, { x: x0 + (boxW - w) / 2, y: y0 + (boxH - h) / 2, width: w, height: h });
    console.log("dnd5e-pdf-exporter | retrato incrustado correctamente");
  } catch (err) {
    console.warn("dnd5e-pdf-exporter | no se pudo incrustar el retrato:", err.message, err);
  }
}

/**
 * Fuerza el tamaño de fuente de un campo de texto escribiendo directamente
 * su cadena de apariencia por defecto (/DA). Esta plantilla en particular
 * tiene campos cuyo /DA no trae el operador "Tf" en el formato que
 * `field.setFontSize()` de pdf-lib espera poder parsear y reemplazar (tira
 * "No Tf operator found for DA of field"), así que lo evitamos por completo
 * escribiendo un /DA nuevo y válido nosotros mismos.
 */
function forceFontSize(field, size) {
  const { PDFName, PDFString } = window.PDFLib;
  const da = `/Helv ${size} Tf 0 g`;
  field.acroField.dict.set(PDFName.of("DA"), PDFString.of(da));
}
function resolvePath(data, path) {
  const parts = path.split(".");
  let cur = data;
  for (const p of parts) {
    if (cur == null) return undefined;
    // soporta buscar por key dentro de un array, ej: "skills[key=acr].mod"
    const arrMatch = p.match(/^(\w+)\[(\w+)=([\w-]+)\]$/);
    if (arrMatch) {
      const [, arrName, keyName, keyVal] = arrMatch;
      cur = cur[arrName]?.find(item => String(item[keyName]) === keyVal);
    } else {
      cur = cur[p];
    }
  }
  return cur;
}

/**
 * @param {Uint8Array} templateBytes
 * @param {Object} fieldMap  { "campo_del_pdf": { source: "ruta.canonica", transform?: "fn" } }
 * @param {Object} canonicalData  salida de buildCanonicalData()
 */
export async function fillPdf(templateBytes, fieldMap, canonicalData) {
  const { PDFDocument, StandardFonts } = window.PDFLib; // expuesto globalmente por pdf-lib UMD
  const pdfDoc = await PDFDocument.load(templateBytes);
  const form = pdfDoc.getForm();
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const transforms = {
    mod: v => (v >= 0 ? `+${v}` : `${v}`),
    bool: v => !!v,
    join: v => Array.isArray(v) ? v.join(", ") : v,
    lines: v => Array.isArray(v) ? v.join("\n") : v,
    // Los campos de descripción de items (rasgos, dotes) vienen en HTML
    // enriquecido y a veces con enlaces internos @UUID[...]{Etiqueta} de
    // Foundry; los campos de texto de un PDF no renderizan ninguno de los
    // dos, así que se limpia todo a texto plano.
    stripHtml: v => typeof v === "string"
      ? v
        .replace(/@UUID\[[^\]]*\]\{([^}]*)\}/g, "$1")
        .replace(/@UUID\[[^\]]*\]/g, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .split("\n").map(l => l.trim()).filter(l => l.length > 0).join("\n")
        .trim()
      : v
  };

  for (const [pdfFieldName, cfg] of Object.entries(fieldMap)) {
    if (pdfFieldName.startsWith("_")) continue; // claves especiales (ej. _portrait), no son campos reales

    const raw = resolvePath(canonicalData, cfg.source);
    if (raw === undefined) continue;

    const value = cfg.transform && transforms[cfg.transform] ? transforms[cfg.transform](raw) : raw;

    try {
      if (cfg.type === "checkbox") {
        const field = form.getCheckBox(pdfFieldName);
        // "threshold": para casillas que representan un conteo (ej. la 2da
        // marca de éxito en salvaciones contra muerte se activa si
        // deathSaves.successes >= 2), en vez de un booleano directo.
        const checked = cfg.threshold !== undefined ? Number(value) >= cfg.threshold : !!value;
        if (checked) field.check(); else field.uncheck();
      } else {
        const field = form.getTextField(pdfFieldName);
        const text = String(value ?? "");

        // "autoSize": para cajas de texto largas (rasgos, equipo, idiomas...)
        // calculamos nosotros mismos el tamaño de fuente que hace que quepa,
        // en vez de usar fontSize=0 ("automático" nativo del PDF) — varios
        // visores (ej. el integrado de Chrome) no lo manejan bien y agrandan
        // el texto en vez de encogerlo.
        if (cfg.autoSize) {
          try {
            // Algunos campos de esta plantilla están marcados como de una
            // sola línea, así que el texto se corta en el borde en vez de
            // saltar de línea aunque quepa el tamaño de fuente. Se fuerza
            // multilínea para que el salto de línea sí funcione.
            try { field.enableMultiline(); } catch { /* ya lo era, o no aplica */ }

            const rect = field.acroField.getWidgets()[0]?.getRectangle();
            if (rect) {
              const size = fitFontSize(helvetica, text, rect.width, rect.height);
              forceFontSize(field, size);
            }
          } catch (err) {
            console.warn(`dnd5e-pdf-exporter | no se pudo autoajustar "${pdfFieldName}"`, err);
          }
        }

        field.setText(text);
      }
    } catch (err) {
      console.warn(`dnd5e-pdf-exporter | campo "${pdfFieldName}" no encontrado o tipo incorrecto en la plantilla`, err);
    }
  }

  // Aplana el formulario para que se vea igual en cualquier visor de PDF.
  // IMPORTANTE: esto va ANTES de incrustar el retrato — flatten() puede
  // regenerar el contenido de la página a partir de las apariencias de los
  // campos, lo que descartaría cualquier dibujo (como la imagen del
  // retrato) hecho después. Comenta esta línea si prefieres que el
  // resultado siga siendo editable (pero entonces el retrato debe ir antes).
  form.flatten();

  await embedPortrait(pdfDoc, fieldMap, canonicalData);

  return pdfDoc.save();
}
