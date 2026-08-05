#!/usr/bin/env node
/**
 * Uso:
 *   node annotate-pdf-fields.js ES_Character_Sheet.pdf
 *
 * Genera ES_Character_Sheet.annotated.pdf: una copia del PDF con el nombre
 * real de cada campo (ej. "Text-tdhhLWTT-s") escrito en rojo justo encima
 * de su posición. Como los nombres de campo de este PDF son hashes sin
 * significado (viene de una herramienta de diseño, no del formulario
 * clásico de WotC), esta es la forma práctica de saber "esta caja de la
 * hoja = este nombre de campo".
 *
 * Ábrelo en cualquier lector de PDF (o el navegador) y ve anotando en
 * templates/es/fieldmap.json qué "source" (ver actor-mapper.js) corresponde
 * a cada nombre que veas junto a cada casilla.
 */
const fs = require("fs");
const { PDFDocument, rgb } = require("pdf-lib");

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("Uso: node annotate-pdf-fields.js ruta/a/tu-hoja.pdf");
    process.exit(1);
  }

  const bytes = fs.readFileSync(path);
  const pdfDoc = await PDFDocument.load(bytes);
  const form = pdfDoc.getForm();
  const fields = form.getFields();
  const pages = pdfDoc.getPages();

  // Mapa ref de página -> índice, para saber en qué página cae cada campo.
  const pageRefToIndex = new Map();
  pages.forEach((p, i) => pageRefToIndex.set(p.ref.toString(), i));

  let drawn = 0;
  let skipped = 0;

  for (const field of fields) {
    const widgets = field.acroField.getWidgets();
    for (const widget of widgets) {
      const pageRef = widget.P?.();
      const pageIndex = pageRef ? pageRefToIndex.get(pageRef.toString()) : undefined;
      if (pageIndex === undefined) { skipped++; continue; }

      const rect = widget.getRectangle(); // { x, y, width, height } en coords del PDF
      const page = pages[pageIndex];

      // Fondo blanco semitransparente detrás del texto para que se lea
      // encima de cualquier color de fondo del diseño.
      page.drawRectangle({
        x: rect.x,
        y: rect.y + rect.height,
        width: Math.max(rect.width, 60),
        height: 7,
        color: rgb(1, 1, 1),
        opacity: 0.7
      });
      page.drawText(field.getName(), {
        x: rect.x,
        y: rect.y + rect.height + 1,
        size: 5,
        color: rgb(0.8, 0, 0)
      });
      drawn++;
    }
  }

  const outPath = path.replace(/\.pdf$/i, ".annotated.pdf");
  fs.writeFileSync(outPath, await pdfDoc.save());
  console.log(`Anotados ${drawn} campos (omitidos ${skipped} sin página detectada).`);
  console.log(`Archivo generado: ${outPath}`);
  console.log("Ábrelo y compara cada etiqueta roja con la casilla debajo.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
