# dnd5e-pdf-exporter

Módulo de Foundry VTT para exportar fichas de personaje del sistema **dnd5e**
al formato de hoja de personaje tradicional en **PDF**, con soporte para
**múltiples idiomas**.

## Cómo funciona (arquitectura)

```
actor (Foundry)
   │
   ▼
actor-mapper.js  →  esquema canónico (mismas claves siempre: str, dex, ac, hp...)
   │
   ▼
pdf-filler.js  +  templates/<lang>/fieldmap.json  +  templates/<lang>/sheet.pdf
   │
   ▼
PDF relleno, descargado al navegador
```

Añadir un idioma nuevo (ej. `pt` para portugués) **no requiere tocar código**:
solo crea `templates/pt/sheet.pdf` + `templates/pt/fieldmap.json`, y añade
`"pt"` a la lista en `scripts/main.js` (`getAvailableLanguages`).

## Dos capas de traducción distintas — importante

1. **Strings de la UI del módulo** (título del diálogo, botones): viven en
   `lang/en.json` / `lang/es.json`, registrados en `module.json` como
   cualquier módulo de Foundry. Ya están hechos.

2. **Términos de juego** (nombre de habilidades, tiradas de salvación,
   escuelas de conjuro, etc.): **no** se traducen a mano en este módulo.
   `translation-loader.js` descarga en tiempo real el `lang/<idioma>.json`
   del sistema dnd5e (y de cualquier módulo de traducción activo) para el
   idioma que elijas al exportar — **independientemente del idioma con el
   que esté corriendo la mesa en ese momento**. Así, si exportas en "es",
   obtienes "Fuerza", "Acrobacias", etc. aunque tu mundo esté en inglés,
   siempre que exista un paquete de idioma español para dnd5e instalado.

   Nombres de hechizos, rasgos y objetos son texto libre del compendio/actor
   y se copian tal cual (no hay traducción automática de esos, salvo que tú
   uses una versión del compendio ya traducida).

## ⚠️ La limitación real: las etiquetas impresas del PDF

La hoja oficial de WotC tiene "STR", "Skills", "Personality Traits", etc.
**dibujados como parte del fondo del PDF**, no como texto de formulario.
Rellenar el PDF oficial en inglés solo traduce los *valores* que metes, no
esas etiquetas fijas. Para una hoja verdaderamente en español necesitas una
plantilla PDF **cuyo fondo ya esté en español** (existen versiones
comunitarias rellenables en español; o puedes encargar/crear una). El
módulo está diseñado para eso: cada idioma usa su propio PDF de fondo, no
intenta traducir el PDF oficial en tiempo real.

## Estado: plantillas y fieldmap ya están completos

Este paquete ya incluye, funcionando de verdad (no como andamiaje):

- `templates/en/sheet.pdf` — la hoja fillable en inglés que subiste (410
  campos con nombres legibles, ej. `STR SCORE`, `Armor Class`).
- `templates/es/sheet.pdf` — la misma hoja con las etiquetas de fondo
  traducidas al español oficial de WotC, **mismos 410 nombres de campo**.
- `templates/en/fieldmap.json` y `templates/es/fieldmap.json` (idénticos,
  ya que los nombres de campo no cambian entre idiomas) — 408 de los 410
  campos mapeados a rutas reales de `actor-mapper.js`.

**Los 2 campos sin mapear, a propósito:**
- `Character Portrait` — es un botón de imagen (`/Btn` tipo ícono), no un
  campo de texto/checkbox; este módulo no sube imágenes, tendrías que
  añadirlo aparte si quieres esa función.
- `CLASS FEATURES 2` — es la caja de "continuación" para cuando los rasgos
  de clase no caben en la primera caja; se deja vacía por simplicidad,
  todos los rasgos van a `CLASS FEATURES 1`.

## Instalación

1. Copia la carpeta completa a `Data/modules/dnd5e-pdf-exporter/` en tu
   Foundry (mismo patrón que tu `campaign-toolkit`), actívalo en el mundo.
2. En la ficha de Bane verás un botón **"Exportar PDF"** en la cabecera →
   elige idioma → descarga.

## Verifica esto en tu mundo real antes de confiar en el resultado

`actor-mapper.js` fue escrito contra la forma general del data model de
dnd5e v3.x, pero varias rutas son sensibles a la versión exacta de tu
sistema y **no pude probarlas contra tu Foundry real** (no tengo acceso a
él desde aquí). Antes de dar por bueno el PDF exportado, revisa con un
actor de prueba en consola (F12):

- `item.labels.toHit` / `item.labels.derivedDamage` (armas) — el nombre
  exacto de estas propiedades cambió entre versiones de dnd5e; si
  `BONUS/DC - WEAPON` o `DAMAGE/TYPE - WEAPON` salen vacíos, inspecciona
  `actor.items.getName("Grave").labels` y ajusta `weapons` en
  `actor-mapper.js`.
- `sys.traits.armorProf.value` — asumo que es un `Set`/iterable de claves
  cortas (`"lgt"`, `"med"`, `"hvy"`, `"shl"`); si `armorProf` sale todo en
  `false`, revisa `actor.system.traits.armorProf` directamente.
- `item.system.type?.value === "class"` para distinguir rasgos de clase de
  dotes — si tu versión de dnd5e categoriza los `feat` distinto, ajusta el
  filtro de `classFeatures`/`feats`.
- `sys.attributes.spellcasting` / `sys.attributes.spelldc` — nombres de
  las propiedades de aptitud mágica; con Bane siendo Paladín/Hexblade
  (dos clases conjuradoras con aptitudes distintas: CAR ambas, de hecho,
  así que no debería haber conflicto — pero vale la pena confirmarlo).

Ninguno de estos errores rompe el módulo — en el peor caso, ese campo
específico sale vacío en el PDF y el resto se exporta bien.

## Extender el esquema canónico

Si necesitas más campos (ej. invocaciones de Warlock, slots de Pacto de
Magia separados de los espacios multiclase), añádelos en `actor-mapper.js`
dentro del objeto que retorna `buildCanonicalData`, y referencia esa ruta
nueva desde `fieldmap.json`. El resto del pipeline no necesita cambios.

Nota: los "espacios de conjuro gastados" (las casillas dentro de cada
nivel) se calculan por posición y umbral (`spellSlots.N.expended >= K`),
no por ID individual de casilla — si el orden visual de esas casillas en
tu PDF no coincide exactamente con el orden por posición x que detecté,
podrían marcarse en el orden incorrecto dentro de la fila (el conteo total
sí sería correcto).
