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
  screenOffBody: string;
  linkInvalidTitle: string;
  linkInvalidBody: string;
  screenRequiredTitle: string;
  screenRequiredBody: string;
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
    screenOffBody: "Waiting for the administrator to turn it on",
    linkInvalidTitle: "This link is no longer valid",
    linkInvalidBody: "Ask the administrator for a new link",
    screenRequiredTitle: "This page needs a signed screen link",
    screenRequiredBody: "Open the screen link from the admin portal",
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
    screenOffBody: "Wacht tot de beheerder de vertaling inschakelt",
    linkInvalidTitle: "Deze link is niet meer geldig",
    linkInvalidBody: "Vraag de beheerder om een nieuwe link",
    screenRequiredTitle: "Deze pagina heeft een beveiligde schermlink nodig",
    screenRequiredBody: "Open de schermlink uit het beheerportaal",
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
    screenOffBody: "Warten, bis der Administrator sie einschaltet",
    linkInvalidTitle: "Dieser Link ist nicht mehr gültig",
    linkInvalidBody: "Bitten Sie den Administrator um einen neuen Link",
    screenRequiredTitle: "Diese Seite braucht einen signierten Bildschirmlink",
    screenRequiredBody: "Öffnen Sie den Bildschirmlink aus dem Admin-Portal",
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
    screenOffBody: "En attente de l'activation par l'administrateur",
    linkInvalidTitle: "Ce lien n'est plus valide",
    linkInvalidBody: "Demandez un nouveau lien à l'administrateur",
    screenRequiredTitle: "Cette page nécessite un lien d’écran signé",
    screenRequiredBody: "Ouvrez le lien d'écran depuis le portail d'administration",
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
    screenOffBody: "Yöneticinin açmasını bekliyor",
    linkInvalidTitle: "Bu bağlantı artık geçerli değil",
    linkInvalidBody: "Yöneticiden yeni bir bağlantı isteyin",
    screenRequiredTitle: "Bu sayfa imzalı bir ekran bağlantısı gerektirir",
    screenRequiredBody: "Ekran bağlantısını yönetim panelinden açın",
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
    screenOffBody: "Esperando a que el administrador la active",
    linkInvalidTitle: "Este enlace ya no es válido",
    linkInvalidBody: "Pida un enlace nuevo al administrador",
    screenRequiredTitle: "Esta página necesita un enlace de pantalla firmado",
    screenRequiredBody: "Abra el enlace de pantalla desde el portal de administración",
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
    screenOffBody: "Menunggu administrator menyalakannya",
    linkInvalidTitle: "Tautan ini sudah tidak berlaku",
    linkInvalidBody: "Minta tautan baru kepada administrator",
    screenRequiredTitle: "Halaman ini memerlukan tautan layar bertanda tangan",
    screenRequiredBody: "Buka tautan layar dari portal admin",
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
    screenOffBody: "بانتظار أن يشغّلها المسؤول",
    linkInvalidTitle: "هذا الرابط لم يعد صالحًا",
    linkInvalidBody: "اطلب من المسؤول رابطًا جديدًا",
    screenRequiredTitle: "تحتاج هذه الصفحة إلى رابط شاشة موقّع",
    screenRequiredBody: "افتح رابط الشاشة من بوابة الإدارة",
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
    screenOffBody: "منتظم کے آن کرنے کا انتظار ہے",
    linkInvalidTitle: "یہ لنک اب درست نہیں رہا",
    linkInvalidBody: "منتظم سے نیا لنک مانگیں",
    screenRequiredTitle: "اس صفحے کو دستخط شدہ اسکرین لنک درکار ہے",
    screenRequiredBody: "انتظامی پورٹل سے اسکرین لنک کھولیں",
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
