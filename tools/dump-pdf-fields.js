#!/usr/bin/env node
/**
 * Uso:
 *   npm install pdf-lib
 *   node tools/dump-pdf-fields.js ruta/a/tu-hoja.pdf
 *
 * Imprime cada campo del formulario del PDF con su nombre EXACTO y tipo,
 * para que puedas construir templates/<lang>/fieldmap.json con datos reales
 * en vez de adivinar nombres de campo.
 */
const fs = require("fs");
const { PDFDocument } = require("pdf-lib");

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("Uso: node dump-pdf-fields.js ruta/a/tu-hoja.pdf");
    process.exit(1);
  }

  const bytes = fs.readFileSync(path);
  const pdfDoc = await PDFDocument.load(bytes);
  const form = pdfDoc.getForm();
  const fields = form.getFields();

  console.log(`\n${fields.length} campos encontrados en ${path}:\n`);

  const skeleton = {};
  for (const field of fields) {
    const name = field.getName();
    const type = field.constructor.name; // PDFTextField, PDFCheckBox, PDFRadioGroup, ...
    console.log(`${type.padEnd(16)} ${name}`);
    skeleton[name] = { source: "TODO", type: type === "PDFCheckBox" ? "checkbox" : "text" };
  }

  const outPath = path.replace(/\.pdf$/i, ".fieldmap.skeleton.json");
  fs.writeFileSync(outPath, JSON.stringify(skeleton, null, 2));
  console.log(`\nEsqueleto de fieldmap escrito en: ${outPath}`);
  console.log("Edita cada \"source\": \"TODO\" para apuntar a la clave canónica correcta (ver actor-mapper.js).");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
