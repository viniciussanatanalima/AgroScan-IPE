import { useState, useEffect, useRef, useCallback } from "react";

/*
 ╔══════════════════════════════════════════════════════════════╗
 ║  AgroScan v2.5 — APK BUILD                                  ║
 ║  • Dados reais do Earth Engine (sem mock data)              ║
 ║  • RVI com Z-Score adaptativo — sem limiares arbitrários    ║
 ║    Z = (último valor − média 30d) / desvio-padrão 30d       ║
 ║  • Guia: 6 páginas (chuva, NDVI, NBR, RVI, Z-Score)        ║
 ║  • Cadastro fire-and-forget — UI não bloqueia               ║
 ║  • FCM push notifications via Firebase                      ║
 ╚══════════════════════════════════════════════════════════════╝
*/

/* ─── BRAND PALETTE ──────────────────────────────────────────────────────── */
const B = {
  bg0: "#03080f", bg1: "#060f1c", bg2: "#091526",
  surface: "#0c1d33", surfaceHi: "#0f2440",
  border: "#122d50", borderHi: "#1a4470",
  teal: "#00b4d8", tealDim: "#007a9a",
  tealGlow: "rgba(0,180,216,0.13)", tealGlow2: "rgba(0,180,216,0.05)",
  blue: "#1565c0", blueDim: "#0d3d7a",
  green: "#3db85c", greenDim: "#1f5c30",
  greenGlow: "rgba(61,184,92,0.13)", greenLight: "#6fcf3d",
  textPrimary: "#e8f4f8", textSub: "#8aafc0", textMuted: "#3d6070",
  red: "#ef5350", orange: "#fb8c00",
};

const FONTS = {
  mono: "'Share Tech Mono', monospace",
  exo:  "'Exo 2', sans-serif",
};

const S = {
  sectionLabel: {
    fontSize: 8.5, color: B.textMuted, letterSpacing: 2.5,
    textTransform: "uppercase", fontFamily: FONTS.mono, marginBottom: 8, marginTop: 18,
  },
  monoXs: { fontFamily: FONTS.mono, fontSize: 8, color: B.textMuted, letterSpacing: 1.5 },
  label: {
    fontSize: 8.5, color: B.teal, letterSpacing: 2, textTransform: "uppercase",
    fontFamily: FONTS.mono, display: "block", marginBottom: 6,
  },
  card: {
    background: B.surface, border: "1px solid " + B.border,
    borderRadius: 14, overflow: "hidden",
  },
  cardRow: (last) => ({
    padding: "12px 16px", display: "flex", justifyContent: "space-between",
    alignItems: "center", borderBottom: last ? "none" : "1px solid " + B.bg1,
  }),
  backBtn: {
    background: B.surface, border: "1px solid " + B.border, borderRadius: 10,
    width: 38, height: 38, cursor: "pointer", color: B.textSub, fontSize: 16,
  },
  inputBase: (err) => ({
    width: "100%", background: B.surface,
    border: `1px solid ${err ? B.red : B.border}`,
    borderRadius: 12, padding: "12px 14px", color: B.textPrimary, outline: "none",
    fontFamily: FONTS.exo, fontSize: 14, boxSizing: "border-box",
  }),
  scrollView: {
    height: "100%", overflowY: "auto",
    padding: "calc(env(safe-area-inset-top, 20px) + 16px) 16px calc(env(safe-area-inset-bottom, 16px) + 80px)",
  },
  infoPill: {
    background: B.tealGlow2, border: "1px solid " + B.tealDim + "44",
    borderRadius: 10, padding: "7px 12px", display: "flex", justifyContent: "space-between",
  },
  metric: {
    background: "rgba(255,255,255,0.03)", border: "1px solid " + B.border,
    borderRadius: 10, padding: "9px 10px", flex: 1, textAlign: "center",
  },
};

/* ─── GOOGLE FONTS ───────────────────────────────────────────────────────── */
const FontLoader = () => {
  useEffect(() => {
    if (document.getElementById("agro-fonts")) return;
    const l = document.createElement("link");
    l.id   = "agro-fonts";
    l.href = "https://fonts.googleapis.com/css2?family=Exo+2:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,700&family=Share+Tech+Mono&display=swap";
    l.rel  = "stylesheet";
    document.head.appendChild(l);
  }, []);
  return null;
};

const CLOUD_FUNCTION_URL    = "https://us-central1-agroscan-ipe.cloudfunctions.net/agroscan_monitor";
const CLOUD_FUNCTION_STATUS = "https://us-central1-agroscan-ipe.cloudfunctions.net/get_farm_status";

/** Aplica dados do Earth Engine sobre um farm existente no array de state. */
function applyEEData(prev, d) {
  return [{
    ...prev[0],
    ndvi:        d.ndvi_mean             ?? prev[0].ndvi,
    nbr:         d.nbr_mean              ?? prev[0].nbr,
    rvi:         d.rvi_mean              ?? prev[0].rvi,
    rain7d:      d.precipitation_sum_7d  ?? prev[0].rain7d,
    rain30d:     d.precipitation_sum_30d ?? prev[0].rain30d,
    dataGap:     d.data_gap              ?? false,
    ndvi_series: d.ndvi_series?.length   ? d.ndvi_series : prev[0].ndvi_series,
    rvi_series:  d.rvi_series?.length    ? d.rvi_series  : prev[0].rvi_series,
  }, ...prev.slice(1)];
}

/* ─── FIREBASE FCM ───────────────────────────────────────────────────────── */
const FCM_CONFIG = {
  apiKey:            "AIzaSyCFntZkmW9c4YE7u5RmPyhnE2QZecBYKZQ",
  authDomain:        "agroscan-ipe.firebaseapp.com",
  projectId:         "agroscan-ipe",
  storageBucket:     "agroscan-ipe.firebasestorage.app",
  messagingSenderId: "872758401279",
  appId:             "1:872758401279:web:cc6db945851c665d9b14ca",
};
const FCM_VAPID_KEY = "BLcVrfOnXqqxwrTImn8hic7jPSxXMjqF-7_Pg1TICC3HhK85Zo2LJm5_VY1ulgfQWfBUMj-MZE7VyDsZJWgIkuE";

async function getFCMToken() {
  try {
    if (!("Notification" in window)) return null;
    if (!window.firebase?.messaging) {
      await new Promise(r => { const s = document.createElement("script"); s.src = "https://www.gstatic.com/firebasejs/10.0.0/firebase-app-compat.js"; s.onload = r; document.head.appendChild(s); });
      await new Promise(r => { const s = document.createElement("script"); s.src = "https://www.gstatic.com/firebasejs/10.0.0/firebase-messaging-compat.js"; s.onload = r; document.head.appendChild(s); });
      if (!window.firebase.apps.length) window.firebase.initializeApp(FCM_CONFIG);
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return null;
    const token = await window.firebase.messaging().getToken({ vapidKey: FCM_VAPID_KEY });
    return token || null;
  } catch (err) {
    console.warn("FCM indisponível:", err);
    return null;
  }
}

/* ─── INITIAL STATE ──────────────────────────────────────────────────────── */
const INITIAL_LOGS = [
  { id: Date.now(), time: "00:00", type: "info", text: "Sistema iniciado. Aguardando cadastro de fazenda." },
];

/* ─── GUIDE PAGES (6 páginas) ────────────────────────────────────────────── */
const GUIDE_PAGES = [
  {
    id: "intro", title: "Manual AgroScan", subtitle: "Satélites a serviço do campo",
    grad: ["#050d1a", "#0a1e3a"], accent: B.teal, emoji: "🛰️",
    content: "O AgroScan combina dados de radar, óptico e meteorológico de 5 satélites diferentes para gerar um diagnóstico completo da sua propriedade. Tudo processado automaticamente no Google Cloud, sem nenhuma instalação.",
    tip: "Você recebe um relatório diário por e-mail e uma notificação push assim que a análise terminar.",
  },
  {
    id: "chuva", title: "Precipitação", subtitle: "Fusão de 3 Fontes Satelitais",
    grad: ["#001a2e", "#002e4a"], accent: B.teal, emoji: "🌧️",
    content: "Os dados de chuva combinam 3 fontes para cobrir os últimos 30 dias sem lacunas: CHIRPS (NASA/UCSB) cobre t-30 a t-5 dias com resolução de 5 km. ERA5-Land (ECMWF) cobre t-5 a t-2 dias. GPM IMERG (NASA) cobre as últimas 48h com latência de apenas 6 horas.",
    ranges: [
      { label: "> 20mm / 7d",  status: "Solo Úmido",             color: B.teal   },
      { label: "5–20mm / 7d",  status: "Precipitação Moderada",  color: B.green  },
      { label: "< 5mm / 7d",   status: "Atenção à Seca",         color: B.orange },
    ],
    tip: "O símbolo * ao lado do valor (ex: 12mm*) indica lacuna em algum segmento — o número é estimativa parcial.",
  },
  {
    id: "ndvi", title: "NDVI", subtitle: "Vigor Vegetativo",
    grad: ["#061a0d", "#0b2e14"], accent: B.green, emoji: "🌿",
    content: "Calculado com bandas infravermelho (B8) e vermelho (B4) do Sentinel-2. É o termômetro da sua lavoura — detecta estresse na atividade fotossintética antes que seja visível a olho nu.",
    ranges: [
      { label: "≥ 0.40", status: "Monitoramento Normal",  color: B.green  },
      { label: "< 0.40", status: "Alerta de Baixo Vigor", color: B.orange },
    ],
    tip: "Alerta acionado: NDVI < 0.4 combinado com chuvas recentes indica provável estresse nutricional ou ataque de pragas.",
  },
  {
    id: "nbr", title: "NBR", subtitle: "Risco de Degradação",
    grad: ["#1a0900", "#2e1400"], accent: B.orange, emoji: "🔥",
    content: "Usa bandas NIR (B8) e SWIR (B12) do Sentinel-2. Avalia o teor de umidade da vegetação. Valores muito baixos são gatilhos para risco de fogo ou seca severa.",
    ranges: [
      { label: "≥ 0.10", status: "Umidade Segura",         color: B.green },
      { label: "< 0.10", status: "Vulnerabilidade Crítica", color: B.red   },
    ],
    tip: "Alerta acionado: NBR < 0.1 dispara aviso imediato de dessecação severa da vegetação.",
  },
  {
    id: "rvi", title: "RVI", subtitle: "Radar de Vegetação",
    grad: ["#030c1f", "#071a38"], accent: B.teal, emoji: "📡",
    content: "O RVI (Radar Vegetation Index) usa o radar SAR do Sentinel-1 para medir a densidade e estrutura da vegetação através das nuvens e à noite. Combina as polarizações VV (vertical-vertical) e VH (vertical-horizontal): quanto mais biomassa e folhagem, maior o espalhamento VH e maior o RVI.",
    ranges: [
      { label: "RVI próximo de 1", status: "Vegetação Densa",     color: B.green  },
      { label: "RVI próximo de 0", status: "Solo Exposto / Seco", color: B.orange },
    ],
    tip: "O radar penetra nuvens e funciona de noite — ideal para regiões tropicais onde o Sentinel-2 frequentemente encontra cobertura de nuvens.",
  },
  {
    id: "zscore", title: "Z-Score RVI", subtitle: "Anomalia Radar Adaptativa",
    grad: ["#030c1f", "#071a38"], accent: B.teal, emoji: "📊",
    content: "O Z-Score compara o RVI atual com o histórico dos últimos 30 dias da sua própria fazenda. Z = (valor atual − média) ÷ desvio-padrão. Isso elimina limiares fixos: o sistema aprende o comportamento normal de cada propriedade individualmente.",
    ranges: [
      { label: "Z > −1.0", status: "Normal",         color: B.teal   },
      { label: "Z < −1.0", status: "Atenção",        color: B.orange },
      { label: "Z < −1.5", status: "Anomalia Radar", color: B.red    },
    ],
    tip: "Uma fazenda com pastagem naturalmente esparsa nunca será alertada pelo mesmo limiar de uma lavoura densa — cada propriedade tem sua própria linha de base.",
  },
];

/* ─── PERSISTÊNCIA ───────────────────────────────────────────────────────── */
const STORAGE_KEYS = { farms: "agroscan:farms", logs: "agroscan:logs" };

function loadFromStorage(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch { return fallback; }
}
function saveToStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch (e) { console.warn("Storage error:", e); }
}

/* ─── Z-SCORE ────────────────────────────────────────────────────────────── */
function calcZScore(series) {
  if (!series || series.length < 2) return null;
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const std  = Math.sqrt(series.reduce((s, v) => s + (v - mean) ** 2, 0) / series.length);
  if (std === 0) return 0;
  return (series[series.length - 1] - mean) / std;
}

/* ─── HELPERS ────────────────────────────────────────────────────────────── */
function getAlertLevel(farm) {
  if (!farm) return null;
  const semDados  = farm.ndvi == null && farm.nbr == null && farm.rvi == null;
  const todosZero = farm.ndvi === 0   && farm.nbr === 0   && farm.rvi === 0;
  if (semDados || todosZero) return "pending";

  const nbr  = farm.nbr  ?? 1;
  const ndvi = farm.ndvi ?? 1;
  const rviZ = calcZScore(farm.rvi_series);

  if (nbr < 0.1 || ndvi < 0.3) return "red";
  if (ndvi < 0.4 || (rviZ !== null && rviZ < -1.5)) return "orange";
  return "green";
}

const ALERT_CFG = {
  green:   { bg: "rgba(61,184,92,0.09)",  border: "#3db85c", dot: "#3db85c", label: "Normal"      },
  orange:  { bg: "rgba(251,140,0,0.10)",  border: "#fb8c00", dot: "#fb8c00", label: "Atenção"     },
  red:     { bg: "rgba(239,83,80,0.10)",  border: "#ef5350", dot: "#ef5350", label: "Crítico"     },
  pending: { bg: "rgba(0,180,216,0.06)",  border: "#007a9a", dot: "#007a9a", label: "Processando" },
};

/* ─── UI ATOMS ───────────────────────────────────────────────────────────── */
function AlertBadge({ level }) {
  const cfg = ALERT_CFG[level] || { bg: B.tealGlow2, border: B.tealDim, dot: B.tealDim, label: "Aguardando" };
  return (
    <span style={{
      background: cfg.bg, border: `1px solid ${cfg.border}55`, color: cfg.dot,
      borderRadius: 20, padding: "3px 10px", fontSize: 9.5, fontWeight: 600,
      letterSpacing: 1.8, textTransform: "uppercase", display: "inline-flex",
      alignItems: "center", gap: 5, fontFamily: FONTS.mono,
    }}>
      <span style={{
        width: 7, height: 7, borderRadius: "50%", background: cfg.dot,
        boxShadow: `0 0 7px ${cfg.dot}`,
        animation: level === "red" ? "agropulse 1.2s ease-in-out infinite" : "none",
      }} />
      {cfg.label}
    </span>
  );
}

function Metric({ label, value, sub, color }) {
  return (
    <div style={S.metric}>
      <div style={{ ...S.monoXs, letterSpacing: 1.8, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: FONTS.mono, fontSize: 17, color: color || B.teal }}>
        {typeof value === "number" ? value.toFixed(3) : "—"}
      </div>
      {sub && (
        <div style={{ fontFamily: FONTS.mono, fontSize: 8, color: color || B.textMuted, marginTop: 2, letterSpacing: 0.5 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function Logo({ size = 34 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      <ellipse cx="50" cy="50" rx="47" ry="19" stroke={B.teal} strokeWidth="2.8" fill="none" transform="rotate(-28 50 50)" opacity="0.85"/>
      <ellipse cx="50" cy="50" rx="47" ry="19" stroke={B.teal} strokeWidth="2.8" fill="none" transform="rotate(28 50 50)" opacity="0.55"/>
      <circle cx="50" cy="50" r="27" fill="url(#gg)"/>
      <path d="M30 50 Q42 40 54 50 Q66 60 70 50" stroke="#ffffff40" strokeWidth="1.5" fill="none"/>
      <path d="M32 56 Q44 46 56 56 Q68 66 72 56" stroke="#ffffff30" strokeWidth="1.2" fill="none"/>
      <path d="M32 44 Q44 34 56 44 Q68 54 72 44" stroke="#ffffff30" strokeWidth="1.2" fill="none"/>
      <circle cx="81" cy="21" r="5" fill={B.teal}/>
      <line x1="81" y1="21" x2="75" y2="28" stroke={B.teal} strokeWidth="2"/>
      <defs>
        <radialGradient id="gg" cx="38%" cy="32%">
          <stop offset="0%" stopColor="#6fcf3d"/>
          <stop offset="55%" stopColor="#2d8a3e"/>
          <stop offset="100%" stopColor="#1a5828"/>
        </radialGradient>
      </defs>
    </svg>
  );
}

function OrbitDeco({ opacity = 0.05 }) {
  return (
    <svg width={140} height={140} viewBox="0 0 120 120"
      style={{ position: "absolute", right: -22, bottom: -22, opacity, pointerEvents: "none" }}>
      <ellipse cx="60" cy="60" rx="55" ry="21" stroke={B.teal} strokeWidth="2" fill="none" transform="rotate(-28 60 60)"/>
      <ellipse cx="60" cy="60" rx="55" ry="21" stroke={B.teal} strokeWidth="2" fill="none" transform="rotate(28 60 60)"/>
      <circle cx="60" cy="60" r="30" stroke={B.teal} strokeWidth="1.5" fill="none"/>
    </svg>
  );
}

/* ─── LEAFLET MAP ────────────────────────────────────────────────────────── */
function LeafletMap({ onPolygonDrawn, drawnCoords }) {
  const mapRef         = useRef(null);
  const mapInstanceRef = useRef(null);
  const [drawMode,   setDrawMode]   = useState(false);
  const [count,      setCount]      = useState(drawnCoords?.length || 0);
  const [layerMode,  setLayerMode]  = useState("sat");
  const polyRef  = useRef(null);
  const pts      = useRef([]);
  const markers  = useRef([]);

  useEffect(() => {
    if (mapInstanceRef.current) return;
    (async () => {
      if (!document.getElementById("lf-css")) {
        const c = document.createElement("link");
        c.id = "lf-css"; c.rel = "stylesheet";
        c.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
        document.head.appendChild(c);
      }
      if (!window.L) await new Promise(r => {
        const s = document.createElement("script");
        s.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
        s.onload = r; document.head.appendChild(s);
      });
      const L   = window.L;
      const map = L.map(mapRef.current, { zoomControl: false }).setView([-14.235, -51.925], 4);
      const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { attribution: "© Esri" });
      const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OSM" });
      sat.addTo(map);
      map._sat = sat; map._osm = osm; map._curL = "sat";
      L.control.zoom({ position: "bottomright" }).addTo(map);
      mapInstanceRef.current = map;
      setTimeout(() => map.invalidateSize(), 100);
      const onResize = () => map.invalidateSize();
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    })();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { if (mapInstanceRef.current) mapInstanceRef.current.invalidateSize(); }, 150);
    return () => clearTimeout(t);
  }, []);

  const toggleLayer = () => {
    const map = mapInstanceRef.current; if (!map || !window.L) return;
    if (map._curL === "sat") { map.removeLayer(map._sat); map._osm.addTo(map); map._curL = "street"; setLayerMode("street"); }
    else { map.removeLayer(map._osm); map._sat.addTo(map); map._curL = "sat"; setLayerMode("sat"); }
  };

  const startDraw = () => {
    const map = mapInstanceRef.current; if (!map || !window.L) return; const L = window.L;
    markers.current.forEach(m => map.removeLayer(m));
    if (polyRef.current) map.removeLayer(polyRef.current);
    pts.current = []; markers.current = []; setCount(0); setDrawMode(true);
    map.getContainer().style.cursor = "crosshair";
    const onClick = e => {
      const ll = [e.latlng.lat, e.latlng.lng]; pts.current.push(ll);
      markers.current.push(L.circleMarker(e.latlng, { radius: 5, color: B.teal, fillColor: B.teal, fillOpacity: 1, weight: 2 }).addTo(map));
      if (pts.current.length > 1) { if (polyRef.current) map.removeLayer(polyRef.current); polyRef.current = L.polyline(pts.current, { color: B.teal, weight: 2, dashArray: "6 4" }).addTo(map); }
      setCount(pts.current.length);
    };
    map.on("click", onClick); map._onClick = onClick;
  };

  const finishDraw = () => {
    const map = mapInstanceRef.current; if (!map || !window.L || pts.current.length < 3) return; const L = window.L;
    map.off("click", map._onClick); map.getContainer().style.cursor = ""; setDrawMode(false);
    markers.current.forEach(m => map.removeLayer(m));
    if (polyRef.current) map.removeLayer(polyRef.current);
    polyRef.current = L.polygon(pts.current, { color: B.teal, fillColor: B.teal, fillOpacity: 0.18, weight: 2 }).addTo(map);
    map.fitBounds(polyRef.current.getBounds(), { padding: [20, 20] });
    const closed = [...pts.current, pts.current[0]];
    onPolygonDrawn(closed.map(([lat, lng]) => [lng, lat]));
    setCount(pts.current.length);
  };

  const clearDraw = () => {
    const map = mapInstanceRef.current; if (!map) return;
    if (map._onClick) map.off("click", map._onClick);
    markers.current.forEach(m => map.removeLayer(m));
    if (polyRef.current) { map.removeLayer(polyRef.current); polyRef.current = null; }
    pts.current = []; markers.current = [];
    map.getContainer().style.cursor = "";
    setDrawMode(false); setCount(0); onPolygonDrawn([]);
  };

  const mapBtnStyle = (disabled, clr = B.teal) => ({
    background: "rgba(3,8,15,0.90)", backdropFilter: "blur(10px)",
    border: `1px solid ${disabled ? B.border : clr}77`, color: disabled ? B.textMuted : clr,
    borderRadius: 8, padding: "5px 10px", fontSize: 9.5, cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: FONTS.mono, letterSpacing: 0.8,
  });

  const MapBtn = ({ label, onClick, disabled, clr }) => (
    <button onClick={onClick} disabled={disabled} style={mapBtnStyle(disabled, clr)}>{label}</button>
  );

  return (
    <div style={{ position: "relative", borderRadius: 14, overflow: "hidden", border: "1px solid " + B.border }}>
      <div ref={mapRef} style={{ width: "100%", height: 210 }} />
      <div style={{ position: "absolute", top: 8, left: 8, zIndex: 1000 }}>
        <MapBtn label={layerMode === "sat" ? "🗺 MAPA" : "🛰 SAT"} onClick={toggleLayer} clr={B.textSub} />
      </div>
      <div style={{ position: "absolute", top: 8, right: 8, zIndex: 1000, display: "flex", gap: 5 }}>
        {!drawMode
          ? <MapBtn label="✏ DESENHAR" onClick={startDraw} />
          : <><MapBtn label={`✓ FECHAR (${count})`} onClick={finishDraw} disabled={count < 3} /><MapBtn label="✕" onClick={clearDraw} clr={B.red} /></>
        }
      </div>
      {drawMode && (
        <div style={{ position: "absolute", bottom: 8, left: "50%", transform: "translateX(-50%)", zIndex: 1000,
          background: "rgba(3,8,15,0.90)", border: `1px solid ${B.teal}44`, borderRadius: 8,
          padding: "4px 12px", fontSize: 9.5, color: B.teal, fontFamily: FONTS.mono, whiteSpace: "nowrap" }}>
          Clique no mapa para adicionar pontos
        </div>
      )}
      {count > 0 && !drawMode && (
        <div style={{ position: "absolute", bottom: 8, left: 8, zIndex: 1000,
          background: "rgba(3,8,15,0.90)", border: `1px solid ${B.green}44`, borderRadius: 8,
          padding: "4px 10px", fontSize: 9.5, color: B.green, fontFamily: FONTS.mono }}>
          ✓ {count} vértices
        </div>
      )}
    </div>
  );
}

/* ─── SPARKLINE CHART ────────────────────────────────────────────────────── */
function SparklineChart({ data, color = "#00b4d8", label = "EVOLUÇÃO (30D)" }) {
  if (!data || data.length < 2) return (
    <div style={{ marginTop: 14, borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ fontSize: 8, color: B.textSub, fontFamily: FONTS.mono, letterSpacing: 1.5 }}>{label}</div>
        <div style={{ fontSize: 8, color: B.textMuted, fontFamily: FONTS.mono }}>AGUARDANDO DADOS</div>
      </div>
      <div style={{ height: 40, background: "rgba(255,255,255,0.02)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontSize: 9, color: B.textMuted, fontFamily: FONTS.mono, letterSpacing: 1 }}>Série temporal indisponível</span>
      </div>
    </div>
  );

  const windowSize = 3;
  const smoothed   = data.map((val, idx, arr) => {
    const start  = Math.max(0, idx - windowSize + 1);
    const subset = arr.slice(start, idx + 1);
    return subset.reduce((a, b) => a + b, 0) / subset.length;
  });

  const min    = Math.min(...smoothed);
  const max    = Math.max(...smoothed);
  const range  = max - min || 1;
  const width  = 280;
  const height = 40;

  const points = smoothed.map((v, i) => {
    const x = (i / (smoothed.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x},${y}`;
  }).join(" ");

  const lastVal = smoothed[smoothed.length - 1];
  const lastY   = height - ((lastVal - min) / range) * height;

  return (
    <div style={{ marginTop: 14, borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 8, color: B.textSub, fontFamily: FONTS.mono, letterSpacing: 1.5 }}>{label}</div>
        <div style={{ fontSize: 8, color, fontFamily: FONTS.mono, letterSpacing: 1 }}>FILTRO SMA-3</div>
      </div>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: "visible" }}>
        <polyline fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round"
          points={points} style={{ filter: `drop-shadow(0 0 3px ${color}80)` }} />
        <circle cx={width} cy={lastY} r="3" fill={color}
          style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
      </svg>
    </div>
  );
}

/* ─── HOME ───────────────────────────────────────────────────────────────── */
function HomeView({ setView, farms, logs, setFarms }) {
  const farm  = farms[0] || null;
  const alert = getAlertLevel(farm);
  const [showNotifs, setShowNotifs] = useState(false);

  const rviZ     = farm ? calcZScore(farm.rvi_series) : null;
  const rviColor = rviZ === null ? B.teal : rviZ < -1.5 ? B.red : rviZ < -1.0 ? B.orange : B.teal;
  const rviSub   = rviZ !== null ? `Z=${rviZ.toFixed(2)}` : null;

  // Polling: tenta recarregar dados a cada 45s enquanto status = "pending"
  useEffect(() => {
    if (!farm || getAlertLevel(farm) !== "pending") return;

    let attempts = 0;
    const MAX    = 13; // ~10 min

    const poll = setInterval(async () => {
      attempts++;
      if (attempts > MAX) { clearInterval(poll); return; }

      try {
        const res  = await fetch(CLOUD_FUNCTION_URL, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ email: farm.email, nome_fazenda: farm.name, coordinates: farm.coords }),
        });
        const json = await res.json();
        if (!res.ok || json.error) return;

        const d = json.data || {};
        if (d.ndvi_mean == null && d.nbr_mean == null && d.rvi_mean == null) return;

        setFarms(prev => [{
          ...prev[0],
          ndvi:        d.ndvi_mean             ?? prev[0].ndvi,
          nbr:         d.nbr_mean              ?? prev[0].nbr,
          rvi:         d.rvi_mean              ?? prev[0].rvi,
          rain7d:      d.precipitation_sum_7d  ?? prev[0].rain7d,
          rain30d:     d.precipitation_sum_30d ?? prev[0].rain30d,
          dataGap:     d.data_gap              ?? false,
          ndvi_series: d.ndvi_series?.length   ? d.ndvi_series : prev[0].ndvi_series,
          rvi_series:  d.rvi_series?.length    ? d.rvi_series  : prev[0].rvi_series,
        }, ...prev.slice(1)]);

        clearInterval(poll);
      } catch { /* silencia erros de rede */ }
    }, 45_000);

    return () => clearInterval(poll);
  }, [farm?.name]);

  return (
    <div style={S.scrollView}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo size={36} />
          <div>
            <div style={{ fontFamily: FONTS.exo, fontSize: 18, fontWeight: 800, color: B.textPrimary, letterSpacing: 3 }}>AGROSCAN</div>
            <div style={{ fontFamily: FONTS.mono, fontSize: 8, color: B.teal, letterSpacing: 2.5 }}>PAINEL DE CONTROLE</div>
          </div>
        </div>
        <div style={{ position: "relative" }}>
          <div onClick={() => setShowNotifs(!showNotifs)} style={{
            background: showNotifs ? B.surfaceHi : B.surface,
            border: `1px solid ${showNotifs ? B.teal : B.border}`,
            borderRadius: 12, width: 40, height: 40, display: "flex",
            alignItems: "center", justifyContent: "center", cursor: "pointer",
            fontSize: 17, transition: "all 0.2s",
          }}>🔔</div>
          {alert === "red" && <div style={{ position: "absolute", top: -3, right: -3, width: 11, height: 11, background: B.red, borderRadius: "50%", border: "2px solid " + B.bg0, animation: "agropulse 1.2s ease-in-out infinite", pointerEvents: "none" }} />}
          {showNotifs && (
            <div style={{ position: "absolute", top: 50, right: 0, width: 260, background: B.surfaceHi, border: `1px solid ${B.borderHi}`, borderRadius: 14, padding: 14, zIndex: 1000, boxShadow: "0 10px 40px rgba(0,0,0,0.8)" }}>
              <div style={{ fontSize: 11, color: B.textPrimary, fontFamily: FONTS.exo, fontWeight: 700, marginBottom: 10, borderBottom: `1px solid ${B.border}`, paddingBottom: 8 }}>Últimas Notificações</div>
              {logs.slice(0, 3).map(log => (
                <div key={log.id} style={{ marginBottom: 10, borderBottom: "1px solid rgba(255,255,255,0.03)", paddingBottom: 8 }}>
                  <div style={{ fontSize: 9, color: B.teal, fontFamily: FONTS.mono, marginBottom: 2 }}>{log.time}</div>
                  <div style={{ fontSize: 11, color: B.textSub, fontFamily: FONTS.exo, lineHeight: 1.4 }}>{log.text}</div>
                </div>
              ))}
              {logs.length === 0 && <div style={{ fontSize: 11, color: B.textMuted }}>Nenhum alerta recente.</div>}
            </div>
          )}
        </div>
      </div>

      {/* Farm card */}
      {farm ? (
        <div style={{ background: `linear-gradient(145deg, ${B.surface}, ${B.surfaceHi})`, border: "1px solid " + B.borderHi, borderTop: "2px solid " + B.teal, borderRadius: 18, padding: 18, marginBottom: 14, position: "relative", overflow: "hidden" }}>
          <OrbitDeco />
          <div style={{ position: "absolute", inset: 0, opacity: 0.025, borderRadius: 18, pointerEvents: "none", backgroundImage: `repeating-linear-gradient(0deg,${B.teal} 0,${B.teal} 1px,transparent 1px,transparent 20px),repeating-linear-gradient(90deg,${B.teal} 0,${B.teal} 1px,transparent 1px,transparent 20px)`, backgroundSize: "20px 20px" }} />
          <div style={{ position: "relative", zIndex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 8.5, color: B.teal, letterSpacing: 2.5, fontFamily: FONTS.mono, marginBottom: 3 }}>● MONITORAMENTO ATIVO</div>
                <div style={{ fontFamily: FONTS.exo, fontSize: 20, fontWeight: 800, color: B.textPrimary }}>{farm.name}</div>
                <div style={{ fontSize: 9.5, color: B.textMuted, fontFamily: FONTS.mono, marginTop: 2 }}>📍 {farm.lastCoord}</div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                <AlertBadge level={alert} />
                {alert === "pending" && (
                  <div style={{
                    padding: "7px 10px", background: "rgba(0,180,216,0.06)",
                    border: "1px solid #007a9a44", borderRadius: 10,
                    fontSize: 9.5, color: B.textMuted, fontFamily: FONTS.exo, lineHeight: 1.6, textAlign: "right",
                  }}>
                    ⏳ Earth Engine processando.<br/>
                    <b style={{ color: B.teal }}>Notificação em até 10 min.</b>
                  </div>
                )}
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <Metric label="NDVI" value={farm.ndvi} color={farm.ndvi >= 0.6 ? B.green : farm.ndvi >= 0.4 ? B.orange : B.red} />
              <Metric label="NBR"  value={farm.nbr}  color={farm.nbr  >= 0.3 ? B.green : farm.nbr  >= 0.1 ? B.orange : B.red} />
              <Metric label="RVI"  value={farm.rvi}  color={rviColor} sub={rviSub} />
            </div>

            <div style={S.infoPill}>
              {[
                ["🌧 7d",     farm.rain7d  != null ? `${farm.rain7d}${farm.dataGap  ? "mm*" : "mm"}` : "—"],
                ["30d",       farm.rain30d != null ? `${farm.rain30d}${farm.dataGap ? "mm*" : "mm"}` : "—"],
                ["📡 Status", "Online"],
              ].map(([k, v]) => (
                <span key={k} style={{ fontSize: 10, color: B.textSub, fontFamily: FONTS.mono }}>
                  {k}: <b style={{ color: B.teal }}>{v}</b>
                </span>
              ))}
            </div>

            <SparklineChart data={farm.ndvi_series} color={B.green} label="NDVI — EVOLUÇÃO (30D)" />
            <SparklineChart data={farm.rvi_series}  color={B.teal}  label="RVI — EVOLUÇÃO (30D)"  />
          </div>
        </div>
      ) : (
        <div style={{ background: B.surface, border: `2px dashed ${B.border}`, borderRadius: 18, padding: 30, textAlign: "center", marginBottom: 14 }}>
          <Logo size={54} />
          <div style={{ fontFamily: FONTS.exo, fontSize: 16, fontWeight: 700, color: B.textPrimary, margin: "14px 0 8px" }}>Nenhuma fazenda ativa</div>
          <div style={{ fontSize: 11, color: B.textMuted, marginBottom: 18, lineHeight: 1.7, fontFamily: FONTS.exo }}>Cadastre sua propriedade para iniciar o monitoramento orbital via satélite</div>
          <button onClick={() => setView("registration")} style={{ background: `linear-gradient(135deg, ${B.blue}, ${B.teal})`, border: "none", borderRadius: 12, padding: "10px 22px", color: "#fff", cursor: "pointer", fontFamily: FONTS.exo, fontWeight: 700, fontSize: 12, letterSpacing: 1 }}>+ CADASTRAR FAZENDA</button>
        </div>
      )}

      {/* Quick actions */}
      <div style={S.sectionLabel}>AÇÕES RÁPIDAS</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 18 }}>
        {[
          { icon: "➕", label: "Nova Fazenda", view: "registration", accent: B.green },
          { icon: "📖", label: "Guia Técnico", view: "guide",        accent: B.teal  },
        ].map(a => (
          <button key={a.view} onClick={() => setView(a.view)} style={{ background: B.surface, border: "1px solid " + B.border, borderRadius: 14, padding: "16px 10px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, width: "100%" }}
            onMouseEnter={e => e.currentTarget.style.borderColor = a.accent}
            onMouseLeave={e => e.currentTarget.style.borderColor = B.border}>
            <span style={{ fontSize: 26 }}>{a.icon}</span>
            <span style={{ fontFamily: FONTS.exo, fontSize: 11, fontWeight: 600, color: B.textSub }}>{a.label}</span>
          </button>
        ))}
      </div>

      {/* Activity log */}
      <div style={S.sectionLabel}>LOG DE ATIVIDADES</div>
      <div style={S.card}>
        {logs.slice(0, 10).map((log, i) => {
          const dot = { success: B.green, warning: B.orange, error: B.red, info: B.teal }[log.type] || B.teal;
          return (
            <div key={log.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: i < Math.min(logs.length, 10) - 1 ? "1px solid " + B.bg1 : "none", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)" }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: dot, flexShrink: 0 }} />
              <div style={{ flex: 1, fontSize: 11, color: B.textSub, fontFamily: FONTS.exo }}>{log.text}</div>
              <div style={{ fontSize: 9.5, color: B.textMuted, fontFamily: FONTS.mono, flexShrink: 0 }}>{log.time}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── REGISTRATION ───────────────────────────────────────────────────────── */
function RegistrationView({ setView, onRegister }) {
  const [email,    setEmail]    = useState("");
  const [farmName, setFarmName] = useState("");
  const [coords,   setCoords]   = useState([]);
  const [emailErr, setEmailErr] = useState("");
  const [status,   setStatus]   = useState({ loading: false, message: "", type: "" });

  const validateEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  const allValid = validateEmail(email) && farmName.trim().length > 0 && coords.length >= 3 && !status.loading;

  const handleRegister = async () => {
    if (!validateEmail(email)) { setEmailErr("Formato de e-mail inválido"); return; }
    if (!farmName.trim() || coords.length < 3) {
      setStatus({ loading: false, message: "Preencha todos os campos e desenhe o polígono.", type: "error" });
      return;
    }

    setStatus({ loading: true, message: "Solicitando permissão de notificações...", type: "" });
    const fcmToken = await getFCMToken();

    const newFarm = {
      name: farmName.trim(), email, coords,
      ndvi: null, nbr: null, rvi: null, vv: null,
      rain7d: null, rain30d: null, dataGap: false,
      ndvi_series: [], rvi_series: [],
      lastCoord: coords[0]
        ? `${Math.abs(coords[0][1]).toFixed(4)}°S, ${Math.abs(coords[0][0]).toFixed(4)}°W`
        : "",
    };

    onRegister(newFarm, fcmToken);  // ← App.handleRegister dispara e captura o fetch

    setStatus({
      loading: false,
      message: fcmToken
        ? "Cadastro realizado! Você receberá uma notificação push quando os dados estiverem prontos."
        : "Cadastro realizado! O relatório chegará no seu e-mail em até 10 minutos.",
      type: "success",
    });

    setTimeout(() => setView("home"), 3500);
  };

  const statusColors = {
    success: { bg: B.greenGlow,                      border: B.green, color: B.green, icon: "✓" },
    error:   { bg: "rgba(239,83,80,0.1)",             border: B.red,   color: B.red,   icon: "⚠" },
    loading: { bg: B.tealGlow2,                       border: B.teal,  color: B.teal,  icon: "⏳" },
  };
  const sc = statusColors[status.type || (status.loading ? "loading" : "error")];

  return (
    <div style={S.scrollView}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 22 }}>
        <button onClick={() => setView("home")} style={S.backBtn}>←</button>
        <div>
          <div style={{ fontFamily: FONTS.exo, fontSize: 17, fontWeight: 800, color: B.textPrimary }}>Nova Propriedade</div>
          <div style={{ fontFamily: FONTS.mono, fontSize: 8, color: B.teal, letterSpacing: 2 }}>GEORREFERENCIAMENTO DE TALHÃO</div>
        </div>
      </div>

      {[
        { lbl: "E-MAIL PARA ALERTAS *", ph: "produtor@fazenda.com.br", val: email,    set: v => { setEmail(v); setEmailErr(""); }, type: "email", err: emailErr },
        { lbl: "NOME DA PROPRIEDADE *", ph: "Ex: Fazenda Santa Fé",    val: farmName, set: setFarmName, type: "text", err: "" },
      ].map(f => (
        <div key={f.lbl} style={{ marginBottom: 14 }}>
          <label style={S.label}>{f.lbl}</label>
          <input value={f.val} onChange={e => f.set(e.target.value)} placeholder={f.ph} type={f.type}
            onBlur={() => f.type === "email" && f.val && !validateEmail(f.val) && setEmailErr("Formato inválido")}
            style={S.inputBase(f.err)} />
          {f.err && <div style={{ fontSize: 10, color: B.red, marginTop: 4 }}>{f.err}</div>}
        </div>
      ))}

      <div style={{ marginBottom: 14 }}>
        <label style={S.label}>DELIMITAÇÃO DO TALHÃO *</label>
        <LeafletMap onPolygonDrawn={setCoords} drawnCoords={coords} />
        <div style={{ fontSize: 10, color: B.textMuted, marginTop: 5, fontFamily: FONTS.exo }}>DESENHAR → marque os pontos → FECHAR para confirmar o polígono</div>
      </div>

      {coords.length > 0 && (
        <div style={{ background: B.bg0, border: "1px solid " + B.border, borderRadius: 10, padding: 10, marginBottom: 14 }}>
          <div style={{ ...S.monoXs, marginBottom: 4 }}>GeoJSON GERADO</div>
          <div style={{ fontFamily: FONTS.mono, fontSize: 9, color: B.green, wordBreak: "break-all" }}>
            {`{"type":"Polygon","coordinates":[[${coords.slice(0, 2).map(c => `[${c[0]?.toFixed(4)},${c[1]?.toFixed(4)}]`).join(",")},...]]}`}
          </div>
        </div>
      )}

      {status.message && (
        <div style={{ background: sc.bg, border: `1px solid ${sc.border}66`, borderRadius: 12, padding: "11px 14px", marginBottom: 14, color: sc.color, fontFamily: FONTS.exo, fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <span>{sc.icon}</span>{status.message}
        </div>
      )}

      <button onClick={handleRegister} disabled={!allValid} style={{ width: "100%", background: allValid ? `linear-gradient(135deg, ${B.blue}, ${B.teal})` : B.surface, border: `1px solid ${allValid ? B.teal : B.border}`, borderRadius: 14, padding: "14px", color: allValid ? "#fff" : B.textMuted, cursor: allValid ? "pointer" : "not-allowed", fontFamily: FONTS.exo, fontWeight: 700, fontSize: 13, letterSpacing: 2 }}>
        🛰 {status.loading ? "ENVIANDO..." : "ATIVAR AGROSCAN"}
      </button>
    </div>
  );
}

/* ─── GUIDE ──────────────────────────────────────────────────────────────── */
function GuideView({ setView }) {
  const [page, setPage] = useState(0);
  const cur = GUIDE_PAGES[page];
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: `linear-gradient(160deg, ${cur.grad[0]}, ${cur.grad[1]})`, transition: "background 0.5s", padding: "calc(env(safe-area-inset-top, 20px) + 16px) 20px calc(env(safe-area-inset-bottom, 16px) + 80px)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 26 }}>
        <button onClick={() => setView("home")} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, padding: "6px 14px", color: "rgba(255,255,255,0.65)", cursor: "pointer", fontSize: 12, fontFamily: FONTS.exo, fontWeight: 600 }}>← Voltar</button>
        <div style={{ fontFamily: FONTS.mono, fontSize: 9, color: "rgba(255,255,255,0.3)", letterSpacing: 2 }}>{page + 1} / {GUIDE_PAGES.length}</div>
        <div style={{ width: 64 }} />
      </div>
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start", textAlign: "center", paddingTop: 8, paddingBottom: 12 }}>
        <div style={{ fontSize: 54, marginBottom: 16 }}>{cur.emoji}</div>
        <div style={{ fontFamily: FONTS.exo, fontSize: 28, fontWeight: 800, color: "#fff", letterSpacing: 3, textTransform: "uppercase" }}>{cur.title}</div>
        <div style={{ fontFamily: FONTS.mono, fontSize: 9.5, color: cur.accent, letterSpacing: 3, textTransform: "uppercase", margin: "4px 0 14px" }}>{cur.subtitle}</div>
        <div style={{ fontFamily: FONTS.exo, fontSize: 13, lineHeight: 1.8, color: "rgba(255,255,255,0.7)", maxWidth: 285, marginBottom: 20 }}>{cur.content}</div>
        {cur.ranges && (
          <div style={{ width: "100%", maxWidth: 295, display: "flex", flexDirection: "column", gap: 7, marginBottom: 18 }}>
            {cur.ranges.map(r => (
              <div key={r.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(255,255,255,0.05)", borderRadius: 10, padding: "8px 14px", border: "1px solid rgba(255,255,255,0.07)" }}>
                <span style={{ fontFamily: FONTS.mono, fontSize: 12, color: r.color }}>{r.label}</span>
                <span style={{ fontFamily: FONTS.exo, fontSize: 12, color: "rgba(255,255,255,0.55)" }}>{r.status}</span>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: r.color, boxShadow: `0 0 6px ${r.color}` }} />
              </div>
            ))}
          </div>
        )}
        <div style={{ background: "rgba(255,255,255,0.05)", border: `1px solid ${cur.accent}44`, borderLeft: `3px solid ${cur.accent}`, borderRadius: 10, padding: "10px 14px", maxWidth: 295, textAlign: "left" }}>
          <div style={{ fontSize: 8.5, color: cur.accent, letterSpacing: 2, textTransform: "uppercase", fontFamily: FONTS.mono, marginBottom: 4 }}>💡 DICA DE CAMPO</div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", fontFamily: FONTS.exo, lineHeight: 1.6 }}>{cur.tip}</div>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 20 }}>
        {[
          { show: page > 0,                      label: "←", onClick: () => setPage(p => p - 1) },
          { show: page < GUIDE_PAGES.length - 1, label: "→", onClick: () => setPage(p => p + 1) },
        ].map((btn, bi) => (
          <button key={bi} onClick={btn.onClick} disabled={!btn.show} style={{ background: btn.show ? "rgba(255,255,255,0.1)" : "transparent", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12, padding: "10px 18px", color: btn.show ? "#fff" : "transparent", cursor: btn.show ? "pointer" : "default", fontSize: 16 }}>{btn.label}</button>
        ))}
        <div style={{ display: "flex", gap: 6 }}>
          {GUIDE_PAGES.map((_, i) => (
            <button key={i} onClick={() => setPage(i)} style={{ width: i === page ? 24 : 8, height: 8, borderRadius: 4, background: i === page ? cur.accent : "rgba(255,255,255,0.2)", border: "none", cursor: "pointer", transition: "all 0.3s", padding: 0 }} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── SETTINGS ───────────────────────────────────────────────────────────── */
function SettingsView({ farms }) {
  const farm    = farms[0];
  const InfoCard = ({ rows }) => (
    <div style={S.card}>
      {rows.map((r, i) => (
        <div key={i} style={S.cardRow(i === rows.length - 1)}>
          <span style={{ fontSize: 12, color: B.textMuted, fontFamily: FONTS.exo }}>{r.label}</span>
          <span style={{ fontSize: r.mono ? 10 : 12, color: r.color || B.textSub, fontFamily: r.mono ? FONTS.mono : FONTS.exo, maxWidth: "60%", textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.value}</span>
        </div>
      ))}
    </div>
  );

  return (
    <div style={S.scrollView}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <Logo size={30} />
        <div style={{ fontFamily: FONTS.exo, fontSize: 17, fontWeight: 800, color: B.textPrimary }}>Configurações</div>
      </div>
      <div style={S.sectionLabel}>CONTA</div>
      <InfoCard rows={[
        { label: "E-mail",       value: farm?.email || "—" },
        { label: "Propriedade",  value: farm?.name  || "—" },
        { label: "Status",       value: farm ? "Ativo" : "Sem cadastro", color: farm ? B.green : B.textMuted },
      ]} />
      <div style={S.sectionLabel}>SATÉLITES & FONTES</div>
      <InfoCard rows={[
        { label: "🛰 Sentinel-2",   value: "Óptico · ESA Copernicus",    color: B.green  },
        { label: "📡 Sentinel-1",   value: "Radar SAR · ESA (VV + VH)",  color: B.teal   },
        { label: "🌧 CHIRPS + GPM", value: "Data Fusion · NASA/UCSB",    color: B.teal   },
        { label: "☁️ Google EE",    value: "Processamento em nuvem",     color: B.textSub },
      ]} />
      <div style={S.sectionLabel}>ALGORITMOS</div>
      <InfoCard rows={[
        { label: "NDVI / NBR",  value: "Sentinel-2 Harmonized",  mono: true               },
        { label: "RVI",         value: "4×VH / (VV + VH)",       mono: true, color: B.teal   },
        { label: "Alerta RVI",  value: "Z-Score < -1.5σ",        mono: true, color: B.orange },
        { label: "Suavização",  value: "SMA-3 (30 dias)",         mono: true               },
      ]} />
      <div style={S.sectionLabel}>INFRAESTRUTURA GCP</div>
      <InfoCard rows={[
        { label: "Cloud Function", value: "Python 3.10 · v2",      mono: true               },
        { label: "Scheduler Cron", value: "0 6 * * * (06h)",       mono: true, color: B.teal },
        { label: "Banco de dados", value: "Firestore NoSQL",        mono: true               },
        { label: "Segredos",       value: "GCP Secret Manager",     mono: true               },
      ]} />
      <div style={S.sectionLabel}>LICENÇAS</div>
      <div style={{ ...S.card, padding: 14 }}>
        <div style={{ fontSize: 11, color: B.textMuted, fontFamily: FONTS.exo, lineHeight: 1.7 }}>
          Dados Sentinel © Programa Copernicus (ESA). CHIRPS © NASA/UCSB. Bibliotecas sob Apache 2.0. AgroScan respeita os limites de quota da Google Earth Engine API.
        </div>
      </div>
      <div style={{ marginTop: 28, textAlign: "center", paddingBottom: 8 }}>
        <Logo size={30} />
        <div style={{ fontFamily: FONTS.mono, fontSize: 8, color: B.textMuted, letterSpacing: 2, marginTop: 8 }}>AGROSCAN v2.5 — APK BUILD · UFABC</div>
      </div>
    </div>
  );
}

/* ─── BOTTOM NAV ─────────────────────────────────────────────────────────── */
function BottomNav({ view, setView }) {
  const tabs = [
    { id: "home",         icon: "⌂",  label: "Home"    },
    { id: "registration", icon: "+",  label: "Cadastro" },
    { id: "guide",        icon: "📖", label: "Guia"    },
    { id: "settings",     icon: "⚙", label: "Config"  },
  ];
  return (
    <div style={{
      position: "absolute", bottom: 0, left: 0, right: 0,
      height: "calc(68px + env(safe-area-inset-bottom, 0px))",
      paddingBottom: "env(safe-area-inset-bottom, 0px)",
      background: "rgba(3,8,15,0.97)", backdropFilter: "blur(20px)",
      borderTop: `1px solid ${B.border}`, display: "flex", alignItems: "flex-start",
      justifyContent: "space-around", paddingTop: 6, zIndex: 100,
    }}>
      {tabs.map(t => {
        const active = view === t.id;
        return (
          <button key={t.id} onClick={() => setView(t.id)} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "6px 12px" }}>
            <div style={{ width: 38, height: 38, borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19, transition: "all 0.25s", background: active ? B.tealGlow : "transparent", border: active ? `1px solid ${B.teal}44` : "1px solid transparent", color: active ? B.teal : B.textMuted }}>{t.icon}</div>
            <span style={{ fontSize: 8, color: active ? B.teal : B.textMuted, fontFamily: FONTS.mono, letterSpacing: 1 }}>{t.label.toUpperCase()}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ─── ROOT APP ───────────────────────────────────────────────────────────── */
export default function App() {
  const [view,  setView]  = useState("home");
  const [farms, setFarms] = useState([]);
  const [logs,  setLogs]  = useState(INITIAL_LOGS);

  useEffect(() => {
    const savedFarms = loadFromStorage(STORAGE_KEYS.farms, []);
    setFarms(savedFarms);
    setLogs(loadFromStorage(STORAGE_KEYS.logs, INITIAL_LOGS));

    // Recovery: se o app foi fechado enquanto pending, busca resultado já salvo
    // via get_farm_status (somente leitura — NÃO cria nova fazenda)
    const pending   = savedFarms[0];
    const isPending = pending?.farmId &&
                      pending.ndvi == null && pending.nbr == null && pending.rvi == null;
    if (isPending) {
      fetch(CLOUD_FUNCTION_STATUS, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ farm_id: pending.farmId }),
      })
        .then(r => r.json())
        .then(json => {
          if (json.status !== "ready" || !json.data) return;
          setFarms(prev => applyEEData(prev, json.data));
        })
        .catch(() => {});
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/firebase-messaging-sw.js")
        .catch(err => console.warn("SW:", err));
    }
  }, []);

  useEffect(() => { saveToStorage(STORAGE_KEYS.farms, farms); }, [farms]);
  useEffect(() => { saveToStorage(STORAGE_KEYS.logs,  logs);  }, [logs]);

  const addLog = useCallback((text, type = "info") => {
    const time = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    setLogs(prev => [{ id: Date.now(), time, type, text }, ...prev].slice(0, 10));
  }, []);

  // Recebe farm (valores null) + fcmToken do RegistrationView.
  // Salva imediatamente e dispara fetch em background — captura a resposta
  // para atualizar o estado quando o Earth Engine terminar.
  const handleRegister = useCallback((farm, fcmToken) => {
    setFarms(prev => [farm, ...prev]);
    addLog(`Fazenda "${farm.name}" cadastrada — monitoramento iniciado`, "success");
    addLog(`Relatório enviado para ${farm.email}`, "info");
    addLog("Processamento Sentinel-2 agendado para próxima janela orbital", "info");

    fetch(CLOUD_FUNCTION_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email: farm.email, nome_fazenda: farm.name, coordinates: farm.coords, fcm_token: fcmToken }),
    })
      .then(r => r.json())
      .then(json => {
        if (!json?.data) return;
        // Salva o farm_id retornado pelo backend para uso no polling e recovery
        if (json.farm_id) {
          setFarms(prev => [{ ...prev[0], farmId: json.farm_id }, ...prev.slice(1)]);
        }
        setFarms(prev => applyEEData(prev, json.data));
        addLog(`Dados orbitais recebidos para "${farm.name}"`, "success");
      })
      .catch(() => {});
  }, [addLog]);

  return (
    <>
      <FontLoader />
      <style>{`
        @keyframes agropulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.45;transform:scale(1.5)} }
        *{box-sizing:border-box;margin:0;padding:0}
        html,body,#root{height:100%;background:${B.bg0}}
        ::-webkit-scrollbar{width:2px}
        ::-webkit-scrollbar-thumb{background:${B.border};border-radius:2px}
        input:focus{outline:none!important;border-color:${B.teal}!important;box-shadow:0 0 0 3px ${B.tealGlow}!important}
        *{-webkit-user-select:none;user-select:none}
        input,textarea{-webkit-user-select:text;user-select:text}
      `}</style>
      <div style={{
        position: "relative", width: "100vw", height: "100vh",
        background: B.bg0, overflow: "hidden",
        backgroundImage: `
          radial-gradient(ellipse at 20% 15%, rgba(0,100,180,0.08) 0%, transparent 55%),
          radial-gradient(ellipse at 80% 85%, rgba(0,150,200,0.06) 0%, transparent 55%)`,
      }}>
        <div style={{ position: "absolute", inset: 0 }}>
          {view === "home"         && <HomeView setView={setView} farms={farms} logs={logs} setFarms={setFarms} />}
          {view === "registration" && <RegistrationView setView={setView} onRegister={handleRegister} />}
          {view === "guide"        && <GuideView setView={setView} />}
          {view === "settings"     && <SettingsView farms={farms} />}
        </div>
        <BottomNav view={view} setView={setView} />
      </div>
    </>
  );
}