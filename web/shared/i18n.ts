// UI labels of the caption views, localised by the TARGET language: the audience reads the target
// language. English is the fallback.
import { baseLang } from "../../src/shared/lang.js";
import type { PrayerEvent } from "../../src/shared/protocol.js";

export interface UiLabels {
  live: string;
  newItems: string;
  ended: string;
  source: string;
  quran: string;
  fullscreen: string;
  export: string;
  sessionStart: string;
  loading: string;
  listening: string;
  connecting: string;
  smaller: string;
  larger: string;
  archive: string;
  /** Status word while a screen is switched off. */
  off: string;
  screenOffTitle: string;
  linkInvalidTitle: string;
  screenRequiredTitle: string;
}

const LABELS: Record<string, UiLabels> = {
  en: {
    live: "Live translation",
    newItems: "new",
    ended: "Session ended",
    source: "Source",
    quran: "Quran",
    fullscreen: "Fullscreen",
    export: "Export",
    sessionStart: "Start of the session",
    loading: "Loading…",
    listening: "Listening…",
    connecting: "Connecting…",
    smaller: "Smaller text",
    larger: "Larger text",
    archive: "Session archive",
    off: "Off",
    screenOffTitle: "Live translation is off",
    linkInvalidTitle: "This link is no longer valid",
    screenRequiredTitle: "This page needs a signed screen link",
  },
  nl: {
    live: "Live vertaling",
    newItems: "nieuw",
    ended: "Sessie beëindigd",
    source: "Bron",
    quran: "Koran",
    fullscreen: "Volledig scherm",
    export: "Exporteren",
    sessionStart: "Begin van de sessie",
    loading: "Laden…",
    listening: "Luistert…",
    connecting: "Verbinden…",
    smaller: "Kleinere tekst",
    larger: "Grotere tekst",
    archive: "Sessie-archief",
    off: "Uit",
    screenOffTitle: "Live vertaling staat uit",
    linkInvalidTitle: "Deze link is niet meer geldig",
    screenRequiredTitle: "Deze pagina heeft een beveiligde schermlink nodig",
  },
  de: {
    live: "Live-Übersetzung",
    newItems: "neu",
    ended: "Sitzung beendet",
    source: "Quelle",
    quran: "Koran",
    fullscreen: "Vollbild",
    export: "Exportieren",
    sessionStart: "Beginn der Sitzung",
    loading: "Laden…",
    listening: "Hört zu…",
    connecting: "Verbinden…",
    smaller: "Kleinere Schrift",
    larger: "Größere Schrift",
    archive: "Sitzungsarchiv",
    off: "Aus",
    screenOffTitle: "Live-Übersetzung ist aus",
    linkInvalidTitle: "Dieser Link ist nicht mehr gültig",
    screenRequiredTitle: "Diese Seite braucht einen signierten Bildschirmlink",
  },
  fr: {
    live: "Traduction en direct",
    newItems: "nouveau",
    ended: "Session terminée",
    source: "Source",
    quran: "Coran",
    fullscreen: "Plein écran",
    export: "Exporter",
    sessionStart: "Début de la session",
    loading: "Chargement…",
    listening: "Écoute…",
    connecting: "Connexion…",
    smaller: "Texte plus petit",
    larger: "Texte plus grand",
    archive: "Archive de la session",
    off: "Arrêt",
    screenOffTitle: "La traduction en direct est désactivée",
    linkInvalidTitle: "Ce lien n'est plus valide",
    screenRequiredTitle: "Cette page nécessite un lien d’écran signé",
  },
  tr: {
    live: "Canlı çeviri",
    newItems: "yeni",
    ended: "Oturum sona erdi",
    source: "Kaynak",
    quran: "Kuran",
    fullscreen: "Tam ekran",
    export: "Dışa aktar",
    sessionStart: "Oturumun başı",
    loading: "Yükleniyor…",
    listening: "Dinleniyor…",
    connecting: "Bağlanıyor…",
    smaller: "Daha küçük yazı",
    larger: "Daha büyük yazı",
    archive: "Oturum arşivi",
    off: "Kapalı",
    screenOffTitle: "Canlı çeviri kapalı",
    linkInvalidTitle: "Bu bağlantı artık geçerli değil",
    screenRequiredTitle: "Bu sayfa imzalı bir ekran bağlantısı gerektirir",
  },
  es: {
    live: "Traducción en directo",
    newItems: "nuevos",
    ended: "Sesión finalizada",
    source: "Fuente",
    quran: "Corán",
    fullscreen: "Pantalla completa",
    export: "Exportar",
    sessionStart: "Inicio de la sesión",
    loading: "Cargando…",
    listening: "Escuchando…",
    connecting: "Conectando…",
    smaller: "Texto más pequeño",
    larger: "Texto más grande",
    archive: "Archivo de la sesión",
    off: "Apagada",
    screenOffTitle: "La traducción en directo está apagada",
    linkInvalidTitle: "Este enlace ya no es válido",
    screenRequiredTitle: "Esta página necesita un enlace de pantalla firmado",
  },
  id: {
    live: "Terjemahan langsung",
    newItems: "baru",
    ended: "Sesi berakhir",
    source: "Sumber",
    quran: "Al-Qur'an",
    fullscreen: "Layar penuh",
    export: "Ekspor",
    sessionStart: "Awal sesi",
    loading: "Memuat…",
    listening: "Mendengarkan…",
    connecting: "Menghubungkan…",
    smaller: "Teks lebih kecil",
    larger: "Teks lebih besar",
    archive: "Arsip sesi",
    off: "Mati",
    screenOffTitle: "Terjemahan langsung mati",
    linkInvalidTitle: "Tautan ini sudah tidak berlaku",
    screenRequiredTitle: "Halaman ini memerlukan tautan layar bertanda tangan",
  },
  ar: {
    live: "ترجمة مباشرة",
    newItems: "جديد",
    ended: "انتهت الجلسة",
    source: "المصدر",
    quran: "القرآن",
    fullscreen: "ملء الشاشة",
    export: "تصدير",
    sessionStart: "بداية الجلسة",
    loading: "جارٍ التحميل…",
    listening: "يستمع…",
    connecting: "جارٍ الاتصال…",
    smaller: "نص أصغر",
    larger: "نص أكبر",
    archive: "أرشيف الجلسة",
    off: "متوقفة",
    screenOffTitle: "الترجمة المباشرة متوقفة",
    linkInvalidTitle: "هذا الرابط لم يعد صالحًا",
    screenRequiredTitle: "تحتاج هذه الصفحة إلى رابط شاشة موقّع",
  },
  ur: {
    live: "براہ راست ترجمہ",
    newItems: "نئے",
    ended: "سیشن ختم",
    source: "ماخذ",
    quran: "قرآن",
    fullscreen: "پوری اسکرین",
    export: "برآمد",
    sessionStart: "سیشن کا آغاز",
    loading: "لوڈ ہو رہا ہے…",
    listening: "سن رہا ہے…",
    connecting: "جڑ رہا ہے…",
    smaller: "چھوٹا متن",
    larger: "بڑا متن",
    archive: "سیشن آرکائیو",
    off: "بند",
    screenOffTitle: "براہ راست ترجمہ بند ہے",
    linkInvalidTitle: "یہ لنک اب درست نہیں رہا",
    screenRequiredTitle: "اس صفحے کو دستخط شدہ اسکرین لنک درکار ہے",
  },
};

/** The entry of a language: own keys only ("constructor" is no language). */
function forLang<T>(table: Readonly<Record<string, T>>, lang: string): T | undefined {
  const base = baseLang(lang);
  return Object.hasOwn(table, base) ? table[base] : undefined;
}

export function uiLabels(targetLang: string): UiLabels {
  return forLang(LABELS, targetLang) ?? (LABELS.en as UiLabels);
}

export interface EventLabel {
  ar: string;
  title: string;
  subtitle: string;
}

const AR: Record<PrayerEvent, string> = { athan: "الأذان", iqama: "الإقامة", salah: "الصلاة" };

type EventTexts = Record<PrayerEvent, { title: string; subtitle: string }>;

const EVENT_LABELS_EN: EventTexts = {
  athan: { title: "Athan", subtitle: "Call to prayer" },
  iqama: { title: "Iqama", subtitle: "The prayer begins" },
  salah: { title: "Prayer", subtitle: "" },
};

/** Card labels when the block carries none (config events.labels). */
const EVENT_LABELS: Record<string, EventTexts> = {
  nl: {
    athan: { title: "Athan", subtitle: "Oproep tot het gebed" },
    iqama: { title: "Iqama", subtitle: "Het gebed begint" },
    salah: { title: "Gebed", subtitle: "" },
  },
  en: EVENT_LABELS_EN,
  de: {
    athan: { title: "Adhan", subtitle: "Gebetsruf" },
    iqama: { title: "Iqama", subtitle: "Das Gebet beginnt" },
    salah: { title: "Gebet", subtitle: "" },
  },
  fr: {
    athan: { title: "Adhan", subtitle: "Appel à la prière" },
    iqama: { title: "Iqama", subtitle: "La prière commence" },
    salah: { title: "Prière", subtitle: "" },
  },
  tr: {
    athan: { title: "Ezan", subtitle: "Namaza çağrı" },
    iqama: { title: "Kamet", subtitle: "Namaz başlıyor" },
    salah: { title: "Namaz", subtitle: "" },
  },
};

export function eventLabel(type: PrayerEvent, targetLang: string): EventLabel {
  const l = (forLang(EVENT_LABELS, targetLang) ?? EVENT_LABELS_EN)[type];
  return { ar: AR[type], title: l.title, subtitle: l.subtitle };
}

/** "13:02" in the target language's convention. */
export function clockTime(ms: number, lang: string): string {
  try {
    return new Date(ms).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  } catch {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
}
