import { getTranslations, localizeIn, glossaryLookup } from "./translation-loader.js";

/**
 * Convierte un Actor (personaje) del sistema dnd5e en un objeto "canónico":
 * mismas claves siempre (str, dex, ac, hp, skills[], spells[], ...),
 * sin importar el idioma de exportación ni el layout del PDF destino.
 *
 * NOTA: las rutas de actor.system.* corresponden al data model de dnd5e v3.x.
 * Si tu versión del sistema difiere, ajusta los accesos marcados con TODO
 * comparando contra `actor.system` en la consola (F12 -> game.actors.get(id).system).
 */
/**
 * @param {Actor} actor
 * @param {string} lang
 * @param {Map<string,string>} [domNames]  id de item -> nombre visible capturado
 *   del DOM de la hoja abierta (ver scanNameOverridesFromSheet en main.js).
 *   Tiene prioridad sobre el glosario manual y sobre el nombre en inglés.
 * @param {Object} [bioOverrides] {personalityTraits,ideals,bonds,flaws} capturados
 *   del DOM de la pestaña de biografía (ver scanBiographyOverridesFromSheet en main.js).
 */
export async function buildCanonicalData(actor, lang, domNames = new Map(), bioOverrides = {}) {
  const dict = await getTranslations(lang);
  const t = (key, data) => localizeIn(dict, key, data);
  const g = (category, name) => glossaryLookup(lang, category, name);
  // Orden de prioridad para el nombre de un item: 1) lo que se ve ahora
  // mismo en la hoja abierta (Babele / idioma nativo / Google Translate...,
  // no nos importa cuál) — pero SOLO si es distinto al nombre crudo, porque
  // si no hay ninguna traducción activa en pantalla el DOM simplemente
  // refleja el mismo texto en inglés, y eso no debe bloquear el glosario;
  // 2) el glosario manual de este módulo; 3) el nombre crudo en inglés,
  // como último recurso.
  const nameFor = async (item, category) => {
    const domText = domNames.get(item.id);
    if (domText && domText !== item.name) return domText;
    return await g(category, item.name);
  };
  const sys = actor.system;

  const abilityOrder = ["str", "dex", "con", "int", "wis", "cha"];
  const prof = sys.attributes.prof ?? 0;
  const abilities = abilityOrder.map(key => {
    const a = sys.abilities[key];
    // OJO: en versiones recientes de dnd5e (5.1+), a.save dejó de ser un
    // número plano — por eso lo calculamos nosotros mismos con la fórmula
    // estándar en vez de leer esa propiedad (que causaba "[object Object]"
    // al intentar mostrarla, y tronaba el campo por exceder su límite de
    // caracteres).
    const proficient = !!a.proficient;
    return {
      key,
      label: t(CONFIG.DND5E.abilities[key]?.label ?? `DND5E.Ability${key}`),
      score: a.value,
      mod: a.mod,
      saveMod: a.mod + (proficient ? prof : 0),
      saveProficient: proficient
    };
  });

  const skills = Object.entries(sys.skills ?? {}).map(([key, s]) => {
    const cfg = CONFIG.DND5E.skills[key];
    return {
      key,
      label: t(cfg?.label ?? `DND5E.Skill${key}`),
      ability: cfg?.ability,
      mod: s.total,
      passive: s.passive,
      proficient: s.value >= 1, // 0 = no, 1 = proficient, 2 = expertise (half=0.5 in some versions)
      expertise: s.value >= 2
    };
  });

  // Clases y niveles (multiclase): actor.classes es un dict {identifier: Item5e}
  const classes = await Promise.all(Object.values(actor.classes ?? {}).map(async cls => ({
    name: await nameFor(cls, "misc"),
    levels: cls.system.levels,
    subclass: cls.subclass ? await nameFor(cls.subclass, "misc") : ""
  })));

  const spells = await Promise.all(actor.items
    .filter(i => i.type === "spell")
    .map(async i => {
      const si = i.system;
      // dnd5e 2024 (v4) unificó muchas banderas booleanas en system.properties
      // (un Set), reemplazando el viejo system.components {ritual,material,...}.
      // Se revisan ambos por compatibilidad con versiones distintas.
      const props = si.properties instanceof Set ? si.properties : new Set(si.properties ?? []);
      const concentration = props.has("concentration") || !!si.duration?.concentration || !!si.components?.concentration;
      const ritual = props.has("ritual") || !!si.components?.ritual;
      const material = props.has("material") || !!si.components?.material;

      const activation = si.activation;
      const actTypeLabel = activation?.type
        ? t(CONFIG.DND5E.abilityActivationTypes?.[activation.type]?.label ?? activation.type)
        : "";
      const castingTime = activation?.value && activation.value !== 1
        ? `${activation.value} ${actTypeLabel}`
        : actTypeLabel;

      let range = "";
      const RANGE_FALLBACK = { es: { self: "Uno mismo", touch: "Contacto" } };
      if (si.range?.units === "self") range = t(CONFIG.DND5E.rangeTypes?.self?.label ?? "") || RANGE_FALLBACK[lang]?.self || "Self";
      else if (si.range?.units === "touch") range = t(CONFIG.DND5E.rangeTypes?.touch?.label ?? "") || RANGE_FALLBACK[lang]?.touch || "Touch";
      else if (si.range?.value) range = `${si.range.value} ${si.range.units ?? ""}`.trim();
      else if (si.range?.units) range = t(CONFIG.DND5E.movementUnits?.[si.range.units]?.label ?? si.range.units);

      return {
        name: await nameFor(i, "spells"), // prioridad: DOM de la hoja abierta > glosario manual > inglés
        level: si.level,
        prepared: !!si.prepared, // dnd5e 5.1+: reemplaza a system.preparation.prepared (deprecado)
        school: t(CONFIG.DND5E.spellSchools?.[si.school]?.label ?? si.school),
        castingTime,
        range,
        concentration,
        ritual,
        material
      };
    }));

  const features = actor.items
    .filter(i => ["feat", "background", "race"].includes(i.type))
    .map(i => ({ name: i.name, description: i.system.description?.value ?? "" }));

  // Separados por tipo porque el PDF tiene una caja distinta para cada uno
  // (RASGOS DE CLASE / ATRIBUTOS DE ESPECIE / DOTES son 3 cuadros separados).
  const classFeatures = await Promise.all(actor.items
    .filter(i => i.type === "feat" && i.system.type?.value === "class")
    .map(i => nameFor(i, "classFeatures")));
  // El PDF tiene 2 cajas de "Class Features" lado a lado; se reparte la
  // lista a la mitad para aprovechar el espacio en vez de amontonar todo
  // en la primera caja y dejar la segunda vacía.
  const classFeaturesMid = Math.ceil(classFeatures.length / 2);
  const classFeaturesPart1 = classFeatures.slice(0, classFeaturesMid);
  const classFeaturesPart2 = classFeatures.slice(classFeaturesMid);

  const feats = await Promise.all(actor.items
    .filter(i => i.type === "feat" && ["feat", undefined].includes(i.system.type?.value))
    .map(i => nameFor(i, "feats")));

  // Rasgos reales de especie (Visión en la Oscuridad, Ascendencia Feérica,
  // etc.): dnd5e los otorga como items tipo "feat" con type.value === "race",
  // igual que "class" para rasgos de clase. Antes no se capturaban en
  // ningún lado — por eso no aparecían ni en Species Traits ni en ningún
  // otro cuadro.
  const raceFeatures = await Promise.all(actor.items
    .filter(i => i.type === "feat" && i.system.type?.value === "race")
    .map(i => nameFor(i, "raceFeatures")));

  // Sentidos (Visión en la Oscuridad, etc.), resistencias, inmunidades y
  // vulnerabilidades: esta plantilla de PDF no tiene un cuadro dedicado
  // para esto, así que se añaden como líneas extra dentro de Species Traits.
  const senseUnits = sys.attributes?.senses?.units ?? "ft";
  const senseEntries = Object.entries(sys.attributes?.senses ?? {})
    .filter(([k, v]) => k !== "units" && k !== "special" && typeof v === "number" && v > 0)
    .map(([k, v]) => `${t(CONFIG.DND5E.senses?.[k]?.label ?? k)} ${v} ${senseUnits}`);

  const toLabelList = (set, catalog) => Array.from(set ?? [])
    .map(k => t(catalog?.[k]?.label ?? k));
  const drList = toLabelList(sys.traits?.dr?.value, CONFIG.DND5E.damageTypes);
  const diList = toLabelList(sys.traits?.di?.value, CONFIG.DND5E.damageTypes);
  const dvList = toLabelList(sys.traits?.dv?.value, CONFIG.DND5E.damageTypes);
  const ciList = toLabelList(sys.traits?.ci?.value, CONFIG.DND5E.conditionTypes);

  const speciesTraitsLines = [
    ...raceFeatures,
    senseEntries.length ? `${t("PDFEXPORT.Senses")}: ${senseEntries.join(", ")}` : null,
    drList.length ? `${t("PDFEXPORT.Resistances")}: ${drList.join(", ")}` : null,
    diList.length ? `${t("PDFEXPORT.DamageImmunities")}: ${diList.join(", ")}` : null,
    dvList.length ? `${t("PDFEXPORT.Vulnerabilities")}: ${dvList.join(", ")}` : null,
    ciList.length ? `${t("PDFEXPORT.ConditionImmunities")}: ${ciList.join(", ")}` : null
  ].filter(Boolean);

  // El texto de especie de dnd5e (descripción genérica) suele incluir
  // enlaces internos de Foundry con formato @UUID[...]{Etiqueta} (para
  // Edad/Idiomas/Habilidades/Dote elegidos vía Advancement) — no es HTML,
  // así que se limpia aparte. Ya NO se usa como contenido principal de
  // Species Traits (era solo un índice de categorías, no información real);
  // se deja calculado por si lo quieres usar en otro campo más adelante.
  const stripFoundryRefs = (str) => (str ?? "")
    .replace(/@UUID\[[^\]]*\]\{([^}]*)\}/g, "$1")
    .replace(/@UUID\[[^\]]*\]/g, "");
  const raceTraits = stripFoundryRefs(
    actor.items.find(i => i.type === "race")?.system.description?.value ?? ""
  );

  const equipment = await Promise.all(actor.items
    .filter(i => ["weapon", "equipment", "consumable", "tool", "loot", "container"].includes(i.type))
    .map(async i => ({ name: await nameFor(i, "equipment"), quantity: i.system.quantity ?? 1 })));
  const equipmentLines = equipment.map(e => (e.quantity > 1 ? `${e.name} (x${e.quantity})` : e.name));

  // NOTA: item.labels.toHit / .derivedDamage vienen ya formateados por dnd5e
  // (incluye signo y tipo de daño), pero el nombre exacto de estas propiedades
  // puede variar entre versiones del sistema — verifica en consola con
  // `actor.items.getName("Grave").labels` si algo sale vacío.
  const weapons = await Promise.all(actor.items
    .filter(i => i.type === "weapon")
    .map(async i => ({
      name: await nameFor(i, "equipment"),
      atkBonus: i.labels?.toHit ?? "",
      damage: i.labels?.derivedDamage?.map(d => `${d.formula} ${d.damageType ?? ""}`).join(" / ")
        ?? i.labels?.damage ?? "",
      notes: ""
    })));

  const attunedItems = await Promise.all(actor.items
    .filter(i => i.system?.attuned || i.system?.attunement === 2)
    .map(i => nameFor(i, "equipment")));

  const armorProfSet = new Set(Array.from(sys.traits?.armorProf?.value ?? []));
  const armorProf = {
    light: armorProfSet.has("lgt"),
    medium: armorProfSet.has("med"),
    heavy: armorProfSet.has("hvy"),
    shield: armorProfSet.has("shl")
  };

  // Listas de competencias: dnd5e guarda claves (ej. "mar"/"sim") en sys.traits.
  // t() las traduce vía CONFIG.DND5E si el catálogo de tu versión las contiene;
  // si no, se muestra la clave cruda (ej. "mar") en vez de inventar una ruta
  // de i18n falsa que nunca se resuelve (eso causaba el bug "DND5E.WeaponProfmar").
  // Último respaldo fijo para claves de competencia muy estables que casi
  // nunca cambian entre versiones del sistema, para cuando CONFIG.DND5E no
  // las resuelve (esto es lo que causaba ver literalmente "mar"/"sim" o
  // el string de i18n sin traducir en el PDF).
  const PROF_FALLBACK = {
    es: { mar: "Marcial", sim: "Simple", lgt: "Ligera", med: "Media", hvy: "Pesada", shl: "Escudos" },
    en: { mar: "Martial", sim: "Simple", lgt: "Light", med: "Medium", hvy: "Heavy", shl: "Shields" }
  };
  const profFallback = (k) => PROF_FALLBACK[lang]?.[k] ?? PROF_FALLBACK.en[k] ?? k;

  // Mismo problema que con mar/sim: CONFIG.DND5E.languages no siempre
  // resuelve en esta versión del sistema. Los idiomas base del PHB son muy
  // estables entre versiones, así que sirven como respaldo fijo confiable.
  const LANGUAGE_FALLBACK = {
    es: {
      common: "Común", commonSign: "Señas Comunes", draconic: "Dracónico",
      dwarvish: "Enano", elvish: "Élfico", giant: "Gigante", gnomish: "Gnomo",
      goblin: "Goblin", halfling: "Mediano", orc: "Orco",
      abyssal: "Abisal", celestial: "Celestial", infernal: "Infernal",
      primordial: "Primordial", sylvan: "Silvano", undercommon: "Infracomún",
      deep: "Habla Profunda", druidic: "Druídico", cant: "Jerga de Ladrones"
    }
  };
  const languageFallback = (k) => LANGUAGE_FALLBACK[lang]?.[k] ?? k;

  const weaponProf = [
    ...(sys.traits?.weaponProf?.value ?? [])
      .map(k => t(CONFIG.DND5E.weaponProficiencies?.[k]?.label ?? "") || profFallback(k)),
    ...(sys.traits?.weaponProf?.custom ? sys.traits.weaponProf.custom.split(";") : [])
  ];
  const toolProf = [
    ...(sys.traits?.toolProf?.value ?? [])
      .map(k => t(CONFIG.DND5E.toolProficiencies?.[k]?.label ?? "") || profFallback(k)),
    ...(sys.traits?.toolProf?.custom ? sys.traits.toolProf.custom.split(";") : [])
  ];
  const languages = [
    ...(sys.traits?.languages?.value ?? [])
      .map(k => t(CONFIG.DND5E.languages?.[k]?.label ?? "") || languageFallback(k)),
    ...(sys.traits?.languages?.custom ? sys.traits.languages.custom.split(";") : [])
  ];

  // Lanzamiento de conjuros: dnd5e guarda esto por clase de conjurador
  // (actor.system.attributes.spellcasting = clave de habilidad, ej. "cha").
  const spellAbilityKey = sys.attributes.spellcasting;
  const spellAbility = spellAbilityKey ? sys.abilities[spellAbilityKey] : null;
  const spellcasting = {
    abilityLabel: spellAbilityKey ? t(CONFIG.DND5E.abilities[spellAbilityKey]?.label) : "",
    mod: spellAbility?.mod ?? 0,
    saveDC: sys.attributes.spelldc ?? 0,
    attackBonus: spellAbility ? spellAbility.mod + (sys.attributes.prof ?? 0) : 0,
    get abilityLabelWithPactNote() {
      return pactNote ? `${this.abilityLabel}\n${pactNote}` : this.abilityLabel;
    }
  };

  // Espacios de conjuro nivel 1-9 (tabla multiclase combinada).
  const spellSlots = {};
  for (let lvl = 1; lvl <= 9; lvl++) {
    const s = sys.spells?.[`spell${lvl}`];
    spellSlots[lvl] = { max: s?.max ?? 0, value: s?.value ?? 0 };
  }

  // Magia de Pacto (Brujo): es un fondo de espacios TOTALMENTE aparte —
  // recarga con descanso CORTO, no largo — y vive en system.spells.pact,
  // no en spell1..spell9. Se suma al nivel que le corresponde (ej. nivel 2
  // para un Brujo de nivel 3-4) para que aparezca en la tabla de la hoja,
  // ya que esta plantilla no tiene una casilla separada para Pacto.
  // Nota: si el personaje tuviera Magia de Pacto Y espacios multiclase en
  // el MISMO nivel (poco común, pero posible en niveles altos), esta suma
  // ya no distingue cuáles son de descanso corto vs. largo dentro del
  // total — por eso se agrega `pactNote` como aclaración aparte.
  const pact = sys.spells?.pact;
  let pactNote = "";
  if (pact?.max) {
    const lvl = pact.level ?? 1;
    if (!spellSlots[lvl]) spellSlots[lvl] = { max: 0, value: 0 };
    spellSlots[lvl].max += pact.max;
    spellSlots[lvl].value += pact.value ?? 0;
    pactNote = lang === "es"
      ? `${pact.max} slots de Pacto nvl:${lvl} (SR).`
      : `${pact.max} Pact slots lvl:${lvl} (SR).`;
  }
  for (const lvl of Object.keys(spellSlots)) {
    spellSlots[lvl].expended = Math.max(0, spellSlots[lvl].max - spellSlots[lvl].value);
  }

  const deathSaves = {
    successes: sys.attributes.death?.success ?? 0,
    failures: sys.attributes.death?.failure ?? 0
  };

  const heroicInspiration = !!sys.attributes.inspiration;

  // Suma de dados de golpe máx/gastados a través de todas las clases (multiclase).
  const hdMax = Object.values(actor.classes ?? {}).reduce((sum, c) => sum + (c.system.levels ?? 0), 0);
  const hdSpent = Object.values(actor.classes ?? {}).reduce((sum, c) => sum + (c.system.hd?.spent ?? 0), 0);

  const sizeKey = sys.traits?.size;
  const sizeLabel = sizeKey ? t(CONFIG.DND5E.actorSizes?.[sizeKey]?.label ?? `DND5E.Size${sizeKey}`) : "";

  const shieldEquipped = actor.items.some(i => i.type === "equipment" && i.system.type?.value === "shield" && i.system.equipped);

  const backgroundItem = actor.items.find(i => i.type === "background");
  const raceItem = actor.items.find(i => i.type === "race");
  const backgroundName = backgroundItem ? await nameFor(backgroundItem, "misc") : "";
  const raceName = raceItem ? await nameFor(raceItem, "misc") : "";

  return {
    meta: {
      name: actor.name,
      alignment: sys.details.alignment ?? "",
      background: backgroundName,
      race: raceName,
      xp: sys.details.xp?.value ?? 0,
      level: sys.details.level ?? 0,
      portraitUrl: actor.img ?? "",
      classSummary: classes.map(c => `${c.name} ${c.levels}`).join(" / "),
      subclassSummary: classes.map(c => c.subclass).filter(Boolean).join(" / "),
      classes
    },
    combat: {
      ac: sys.attributes.ac.value,
      initiative: sys.attributes.init?.total ?? sys.attributes.init?.mod ?? 0,
      speed: sys.attributes.movement?.walk ?? 0,
      hpCurrent: sys.attributes.hp.value,
      hpMax: sys.attributes.hp.max,
      hpTemp: sys.attributes.hp.temp ?? 0,
      hitDice: `${sys.details.level}${sys.attributes.hd ? "d" + sys.attributes.hd : ""}`,
      hitDiceMax: hdMax,
      hitDiceSpent: hdSpent,
      sizeLabel,
      shieldEquipped,
      proficiencyBonus: sys.attributes.prof
    },
    abilities,
    skills,
    spells,
    features,
    classFeatures,
    classFeaturesPart1,
    classFeaturesPart2,
    feats,
    raceTraits,
    raceFeatures,
    speciesTraitsLines,
    equipment,
    equipmentLines,
    weapons,
    attunedItems,
    armorProf,
    weaponProf,
    toolProf,
    languages,
    spellcasting,
    spellSlots,
    deathSaves,
    heroicInspiration,
    currency: sys.currency ?? { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 },
    // Texto de personalidad/historia: prioridad al texto ya traducido que
    // se ve en la pestaña de Biografía de la hoja abierta (bioOverrides);
    // si no se pudo capturar (hoja cerrada, pestaña no identificada), cae
    // al dato crudo del actor tal cual esté escrito.
    bio: {
      personalityTraits: bioOverrides.personalityTraits || sys.details.trait || "",
      ideals: bioOverrides.ideals || sys.details.ideal || "",
      bonds: bioOverrides.bonds || sys.details.bond || "",
      flaws: bioOverrides.flaws || sys.details.flaw || "",
      backstory: sys.details.biography?.value ?? "",
      // El PDF solo tiene UNA caja "PERSONALITY" (no 4 separadas como la hoja
      // clásica), así que se combinan aquí con mini-encabezados.
      get combinedText() {
        const parts = [];
        if (this.personalityTraits) parts.push(`${t("PDFEXPORT.Traits")}: ${this.personalityTraits}`);
        if (this.ideals) parts.push(`${t("PDFEXPORT.Ideals")}: ${this.ideals}`);
        if (this.bonds) parts.push(`${t("PDFEXPORT.Bonds")}: ${this.bonds}`);
        if (this.flaws) parts.push(`${t("PDFEXPORT.Flaws")}: ${this.flaws}`);
        return parts.join("\n");
      }
    }
  };
}
