import { useState, useEffect, useRef, useCallback } from "react";

/*
 ╔══════════════════════════════════════════════════════════════╗
 ║  AgroScan v3.0 — APK BUILD                                  ║
 ║  • filterBounds() em todas as coleções GEE                  ║
 ║  • Fallback óptico: S2 → Landsat 8/9 → MODIS               ║
 ║  • MODO RADAR: análise exclusiva por RVI/Z-Score            ║
 ║  • ZScoreGauge: gauge semicircular animado                  ║
 ║  • null exibido como "—", nunca como 0.000                  ║
 ╚══════════════════════════════════════════════════════════════╝
*/

const B = {
  bg0: "#03080f", bg1: "#060f1c", surface: "#0c1d33", surfaceHi: "#0f2440",
  border: "#122d50", borderHi: "#1a4470",
  teal: "#00b4d8", tealDim: "#007a9a",
  tealGlow: "rgba(0,180,216,0.13)", tealGlow2: "rgba(0,180,216,0.05)",
  blue: "#1565c0", green: "#3db85c", greenGlow: "rgba(61,184,92,0.13)",
  textPrimary: "#e8f4f8", textSub: "#8aafc0", textMuted: "#3d6070",
  red: "#ef5350", orange: "#fb8c00",
  radarPurple: "#7c3aed",
};
const FONTS = { mono: "'Share Tech Mono', monospace", exo: "'Exo 2', sans-serif" };

const S = {
  sectionLabel: { fontSize: 8.5, color: B.textMuted, letterSpacing: 2.5, textTransform: "uppercase", fontFamily: FONTS.mono, marginBottom: 8, marginTop: 18 },
  monoXs: { fontFamily: FONTS.mono, fontSize: 8, color: B.textMuted, letterSpacing: 1.5 },
  label: { fontSize: 8.5, color: B.teal, letterSpacing: 2, textTransform: "uppercase", fontFamily: FONTS.mono, display: "block", marginBottom: 6 },
  card: { background: B.surface, border: "1px solid " + B.border, borderRadius: 14, overflow: "hidden" },
  cardRow: (last) => ({ padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: last ? "none" : "1px solid " + B.bg1 }),
  backBtn: { background: B.surface, border: "1px solid " + B.border, borderRadius: 10, width: 38, height: 38, cursor: "pointer", color: B.textSub, fontSize: 16 },
  inputBase: (err) => ({ width: "100%", background: B.surface, border: `1px solid ${err ? B.red : B.border}`, borderRadius: 12, padding: "12px 14px", color: B.textPrimary, outline: "none", fontFamily: FONTS.exo, fontSize: 14, boxSizing: "border-box" }),
  scrollView: { height: "100%", overflowY: "auto", padding: "calc(env(safe-area-inset-top, 20px) + 16px) 16px calc(env(safe-area-inset-bottom, 16px) + 80px)" },
  infoPill: { background: B.tealGlow2, border: "1px solid " + B.tealDim + "44", borderRadius: 10, padding: "7px 12px", display: "flex", justifyContent: "space-between" },
  metric: { background: "rgba(255,255,255,0.03)", border: "1px solid " + B.border, borderRadius: 10, padding: "9px 10px", flex: 1, textAlign: "center" },
};

/* ─── FONTS ─────────────────────────────────────────────────────────────────*/
const FontLoader = () => {
  useEffect(() => {
    if (document.getElementById("agro-fonts")) return;
    const l = document.createElement("link");
    l.id = "agro-fonts";
    l.href = "https://fonts.googleapis.com/css2?family=Exo+2:wght@300;400;600;700;800&family=Share+Tech+Mono&display=swap";
    l.rel = "stylesheet";
    document.head.appendChild(l);
  }, []);
  return null;
};

const CLOUD_FUNCTION_URL    = "https://us-central1-agroscan-ipe.cloudfunctions.net/agroscan_monitor";
const CLOUD_FUNCTION_STATUS = "https://us-central1-agroscan-ipe.cloudfunctions.net/get_farm_status";

/* aplica dados EE preservando nulls (não usa ?? para precipitação que pode ser 0) */
function applyEEData(prev, d) {
  if (!prev || prev.length === 0) return prev;
  return [{
    ...prev[0],
    ndvi:          d.ndvi_mean             ?? prev[0].ndvi,
    nbr:           d.nbr_mean              ?? prev[0].nbr,
    rvi:           d.rvi_mean              ?? prev[0].rvi,
    rain7d:        d.precipitation_sum_7d  != null ? d.precipitation_sum_7d  : prev[0].rain7d,
    rain30d:       d.precipitation_sum_30d != null ? d.precipitation_sum_30d : prev[0].rain30d,
    dataGap:       d.data_gap              ?? false,
    opticalSource: d.optical_source        ?? prev[0].opticalSource,
    ndvi_series:   d.ndvi_series?.length   ? d.ndvi_series : (prev[0].ndvi_series || []),
    rvi_series:    d.rvi_series?.length    ? d.rvi_series  : (prev[0].rvi_series  || []),
  }, ...prev.slice(1)];
}

/* ─── FCM ───────────────────────────────────────────────────────────────────*/
const FCM_CONFIG = { apiKey: "AIzaSyCFntZkmW9c4YE7u5RmPyhnE2QZecBYKZQ", authDomain: "agroscan-ipe.firebaseapp.com", projectId: "agroscan-ipe", storageBucket: "agroscan-ipe.firebasestorage.app", messagingSenderId: "872758401279", appId: "1:872758401279:web:cc6db945851c665d9b14ca" };
const FCM_VAPID = "BLcVrfOnXqqxwrTImn8hic7jPSxXMjqF-7_Pg1TICC3HhK85Zo2LJm5_VY1ulgfQWfBUMj-MZE7VyDsZJWgIkuE";

async function getFCMToken() {
  try {
    if (!("Notification" in window)) return null;
    if (!window.firebase?.messaging) {
      await new Promise(r => { const s = document.createElement("script"); s.src = "https://www.gstatic.com/firebasejs/10.0.0/firebase-app-compat.js"; s.onload = r; document.head.appendChild(s); });
      await new Promise(r => { const s = document.createElement("script"); s.src = "https://www.gstatic.com/firebasejs/10.0.0/firebase-messaging-compat.js"; s.onload = r; document.head.appendChild(s); });
      if (!window.firebase.apps.length) window.firebase.initializeApp(FCM_CONFIG);
    }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return null;
    return await window.firebase.messaging().getToken({ vapidKey: FCM_VAPID }) || null;
  } catch { return null; }
}

/* ─── GUIDE ─────────────────────────────────────────────────────────────────*/
const GUIDE_PAGES = [
  { id: "intro",      title: "Manual AgroScan",  subtitle: "Satélites a serviço do campo",   grad: ["#050d1a","#0a1e3a"], accent: B.teal,        emoji: "🛰️", content: "O AgroScan combina radar, óptico e meteorológico de múltiplos satélites para diagnóstico completo da sua propriedade, processado no Google Cloud.", tip: "Você recebe relatório por e-mail e notificação push quando a análise terminar." },
  { id: "radarmode",  title: "Modo Radar",        subtitle: "Quando o óptico falha",          grad: ["#0d0028","#1a0050"], accent: B.radarPurple, emoji: "📡", content: "Com cobertura total de nuvens, o Sentinel-2 não captura imagens. O AgroScan entra em Modo Radar usando o Sentinel-1 SAR — penetra nuvens, opera 24h.", ranges: [{ label: "Z > −1.0", status: "Normal",   color: B.teal }, { label: "Z < −1.0", status: "Atenção",  color: B.orange }, { label: "Z < −1.5", status: "Anomalia", color: B.red }], tip: "Modo Radar é transparente: o app indica qual satélite está ativo e por quê." },
  { id: "chuva",      title: "Precipitação",      subtitle: "Fusão de 3 Fontes",              grad: ["#001a2e","#002e4a"], accent: B.teal,        emoji: "🌧️", content: "CHIRPS (30–5 dias), ERA5-Land (5–2 dias), GPM IMERG (últimas 48h). Todos com filterBounds para cobertura exata da sua área.", ranges: [{ label: "> 20mm/7d", status: "Solo Úmido", color: B.teal }, { label: "5–20mm/7d", status: "Moderado", color: B.green }, { label: "< 5mm/7d", status: "Atenção à Seca", color: B.orange }], tip: "* ao lado do valor indica lacuna em segmento recente — estimativa parcial." },
  { id: "ndvi",       title: "NDVI",              subtitle: "Vigor Vegetativo",               grad: ["#061a0d","#0b2e14"], accent: B.green,       emoji: "🌿", content: "Calculado com Sentinel-2 (B8/B4), ou Landsat 8/9 como fallback, ou MODIS 250m como último recurso. Detecta estresse antes de ser visível a olho nu.", ranges: [{ label: "≥ 0.40", status: "Normal", color: B.green }, { label: "< 0.40", status: "Alerta", color: B.orange }], tip: "Quando aparece 'Fonte: Landsat' ou 'MODIS', a resolução é menor — dados ainda válidos como tendência." },
  { id: "zscore",     title: "Z-Score RVI",       subtitle: "Anomalia Radar Adaptativa",      grad: ["#030c1f","#071a38"], accent: B.teal,        emoji: "📊", content: "Z = (RVI atual − média 30d) ÷ desvio-padrão. Cada fazenda tem sua própria linha de base. É o índice que nunca para — nem em dias completamente nublados.", ranges: [{ label: "Z > −1.0", status: "Normal",   color: B.teal }, { label: "Z < −1.0", status: "Atenção",  color: B.orange }, { label: "Z < −1.5", status: "Anomalia", color: B.red }], tip: "Uma pastagem naturalmente esparsa nunca recebe o mesmo alerta de uma lavoura densa." },
];

/* ─── STORAGE ───────────────────────────────────────────────────────────────*/
const SK = { farms: "agroscan:farms:v3", logs: "agroscan:logs:v3" };
const load = (k, fb) => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : fb; } catch { return fb; } };
const save = (k, v)  => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

/* ─── Z-SCORE ───────────────────────────────────────────────────────────────*/
function calcZScore(series) {
  if (!series || series.length < 2) return null;
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const std  = Math.sqrt(series.reduce((s, v) => s + (v - mean) ** 2, 0) / series.length);
  if (std === 0) return 0;
  return (series[series.length - 1] - mean) / std;
}

/* ─── HELPERS ───────────────────────────────────────────────────────────────*/
function getAlertLevel(farm) {
  if (!farm) return null;
  if (farm.rvi == null && farm.ndvi == null && farm.nbr == null) return "pending";
  const z = calcZScore(farm.rvi_series);
  if ((farm.nbr  != null && farm.nbr  < 0.1) || (farm.ndvi != null && farm.ndvi < 0.3)) return "red";
  if ((farm.ndvi != null && farm.ndvi < 0.4) || (z !== null && z < -1.5)) return "orange";
  if (z !== null && z < -1.0) return "orange";
  return "green";
}
const ALERT_CFG = {
  green:   { bg: "rgba(61,184,92,0.09)",  border: "#3db85c", dot: "#3db85c", label: "Normal"      },
  orange:  { bg: "rgba(251,140,0,0.10)",  border: "#fb8c00", dot: "#fb8c00", label: "Atenção"     },
  red:     { bg: "rgba(239,83,80,0.10)",  border: "#ef5350", dot: "#ef5350", label: "Crítico"     },
  pending: { bg: "rgba(0,180,216,0.06)",  border: "#007a9a", dot: "#007a9a", label: "Processando" },
};

/* ─── ATOMS ─────────────────────────────────────────────────────────────────*/
function AlertBadge({ level }) {
  const c = ALERT_CFG[level] || { bg: B.tealGlow2, border: B.tealDim, dot: B.tealDim, label: "Aguardando" };
  return (
    <span style={{ background: c.bg, border: `1px solid ${c.border}55`, color: c.dot, borderRadius: 20, padding: "3px 10px", fontSize: 9.5, fontWeight: 600, letterSpacing: 1.8, textTransform: "uppercase", display: "inline-flex", alignItems: "center", gap: 5, fontFamily: FONTS.mono }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: c.dot, boxShadow: `0 0 7px ${c.dot}`, animation: level === "red" ? "agropulse 1.2s ease-in-out infinite" : "none" }}/>
      {c.label}
    </span>
  );
}

/* Metric — null → "—", nunca "0.000" */
function Metric({ label, value, sub, color }) {
  const ok = value != null && typeof value === "number";
  return (
    <div style={S.metric}>
      <div style={{ ...S.monoXs, letterSpacing: 1.8, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: FONTS.mono, fontSize: 17, color: ok ? (color || B.teal) : B.textMuted }}>
        {ok ? value.toFixed(3) : "—"}
      </div>
      {sub && <div style={{ fontFamily: FONTS.mono, fontSize: 8, color: ok ? (color || B.textMuted) : B.textMuted, marginTop: 2 }}>{sub}</div>}
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
      <circle cx="81" cy="21" r="5" fill={B.teal}/><line x1="81" y1="21" x2="75" y2="28" stroke={B.teal} strokeWidth="2"/>
      <defs><radialGradient id="gg" cx="38%" cy="32%"><stop offset="0%" stopColor="#6fcf3d"/><stop offset="55%" stopColor="#2d8a3e"/><stop offset="100%" stopColor="#1a5828"/></radialGradient></defs>
    </svg>
  );
}

function OrbitDeco() {
  return (
    <svg width={140} height={140} viewBox="0 0 120 120" style={{ position: "absolute", right: -22, bottom: -22, opacity: 0.05, pointerEvents: "none" }}>
      <ellipse cx="60" cy="60" rx="55" ry="21" stroke={B.teal} strokeWidth="2" fill="none" transform="rotate(-28 60 60)"/>
      <ellipse cx="60" cy="60" rx="55" ry="21" stroke={B.teal} strokeWidth="2" fill="none" transform="rotate(28 60 60)"/>
      <circle cx="60" cy="60" r="30" stroke={B.teal} strokeWidth="1.5" fill="none"/>
    </svg>
  );
}

/* ─── Z-SCORE GAUGE ─────────────────────────────────────────────────────────*/
function ZScoreGauge({ zscore, rviMean }) {
  const z       = zscore ?? 0;
  const clamped = Math.max(-3, Math.min(3, z));
  /* 0°=esquerda(−3) 180°=direita(+3) no semicírculo */
  const angle = ((clamped + 3) / 6) * 180;
  const toRad = d => ((d - 180) * Math.PI) / 180;
  const cx = 80, cy = 72, r = 55;
  const nx = cx + r * 0.82 * Math.cos(toRad(angle));
  const ny = cy + r * 0.82 * Math.sin(toRad(angle));
  const hasData = zscore !== null;
  const nc = !hasData ? B.textMuted : z < -1.5 ? B.red : z < -1.0 ? B.orange : z < 0 ? B.teal : B.green;
  const label = !hasData ? "Aguardando dados" : z < -1.5 ? "Anomalia Crítica" : z < -1.0 ? "Atenção" : z < 0 ? "Abaixo da Média" : "Normal";

  function arc(f, t, rad) {
    const x1 = cx + rad * Math.cos(toRad(f)), y1 = cy + rad * Math.sin(toRad(f));
    const x2 = cx + rad * Math.cos(toRad(t)), y2 = cy + rad * Math.sin(toRad(t));
    return `M ${x1} ${y1} A ${rad} ${rad} 0 0 1 ${x2} ${y2}`;
  }

  return (
    <div style={{ background: `linear-gradient(145deg, ${B.surface}, rgba(124,58,237,0.08))`, border: `1px solid ${B.radarPurple}44`, borderRadius: 16, padding: "16px 14px", marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div>
          <div style={{ fontFamily: FONTS.mono, fontSize: 8.5, color: B.radarPurple, letterSpacing: 2.5, textTransform: "uppercase" }}>Z-SCORE RVI — ANOMALIA RADAR</div>
          <div style={{ fontFamily: FONTS.exo, fontSize: 11, color: B.textMuted, marginTop: 2 }}>desvio em relação à média histórica (30 dias)</div>
        </div>
        {rviMean != null && (
          <div style={{ textAlign: "right" }}>
            <div style={{ fontFamily: FONTS.mono, fontSize: 8, color: B.textMuted }}>RVI</div>
            <div style={{ fontFamily: FONTS.mono, fontSize: 15, color: B.teal }}>{rviMean.toFixed(3)}</div>
          </div>
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "center" }}>
        <svg width={160} height={90} viewBox="0 0 160 90">
          {/* trilho */}
          <path d={arc(0, 180, 55)} fill="none" stroke={B.border} strokeWidth="8" strokeLinecap="round"/>
          {/* zonas */}
          {[[0,60,B.red],[60,90,B.orange],[90,180,B.teal]].map(([f,t,c],i) => (
            <path key={i} d={arc(f,t,55)} fill="none" stroke={c} strokeWidth="8" strokeLinecap="round" opacity="0.3"/>
          ))}
          {/* progresso */}
          {hasData && <path d={arc(0, angle, 55)} fill="none" stroke={nc} strokeWidth="8" strokeLinecap="round" opacity="0.9" style={{ filter: `drop-shadow(0 0 4px ${nc})` }}/>}
          {/* labels */}
          {[[-3,12,76],[0,80,18],[3,148,76]].map(([v,x,y]) => (
            <text key={v} x={x} y={y} fill={B.textMuted} fontSize="9" fontFamily={FONTS.mono} textAnchor="middle">{v>0?`+${v}`:v}</text>
          ))}
          {/* agulha */}
          {hasData && <>
            <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={nc} strokeWidth="2.5" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 3px ${nc})` }}/>
            <circle cx={cx} cy={cy} r="5" fill={B.surfaceHi} stroke={nc} strokeWidth="2"/>
          </>}
          {!hasData && <circle cx={cx} cy={cy} r="5" fill={B.surfaceHi} stroke={B.textMuted} strokeWidth="2"/>}
          <text x={cx} y={cy+20} fill={nc} fontSize="15" fontFamily={FONTS.mono} textAnchor="middle" fontWeight="bold">
            {hasData ? (z >= 0 ? `+${z.toFixed(2)}` : z.toFixed(2)) : "—"}
          </text>
        </svg>
      </div>
      <div style={{ textAlign: "center", marginTop: -4 }}>
        <span style={{ fontFamily: FONTS.exo, fontSize: 12, fontWeight: 700, color: nc }}>{label}</span>
        {!hasData && rviMean != null && (
          <div style={{ fontFamily: FONTS.mono, fontSize: 9, color: B.textMuted, marginTop: 3 }}>Mín. 2 passagens do Sentinel-1 para calcular Z-Score</div>
        )}
      </div>
    </div>
  );
}

/* ─── RADAR MODE CARD ────────────────────────────────────────────────────────*/
function RadarModeCard({ rvi, rviZ, rviSeries }) {
  const nc  = rviZ === null ? B.teal : rviZ < -1.5 ? B.red : rviZ < -1.0 ? B.orange : B.teal;
  const msg = rviZ === null
    ? "Aguardando mais passagens do Sentinel-1 para calcular o Z-Score."
    : rviZ < -1.5 ? "Anomalia Crítica: estrutura vegetal abaixo do esperado histórico."
    : rviZ < -1.0 ? "Leve queda na vegetação radar — monitore nas próximas passagens."
    : "Estrutura vegetal estável segundo o Sentinel-1 SAR.";

  return (
    <div style={{ background: `linear-gradient(145deg, ${B.surface}, rgba(124,58,237,0.10))`, border: `2px solid ${B.radarPurple}55`, borderRadius: 18, padding: 18, marginBottom: 14, position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 12, right: 16, fontSize: 36, opacity: 0.10, pointerEvents: "none" }}>📡</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ background: `${B.radarPurple}22`, border: `1px solid ${B.radarPurple}55`, color: B.radarPurple, borderRadius: 20, padding: "3px 10px", fontSize: 9.5, fontWeight: 700, letterSpacing: 1.8, textTransform: "uppercase", fontFamily: FONTS.mono, display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: B.radarPurple, boxShadow: `0 0 7px ${B.radarPurple}`, animation: "agropulse 2s ease-in-out infinite" }}/>
          MODO RADAR ATIVO
        </span>
      </div>
      <div style={{ fontFamily: FONTS.exo, fontSize: 12, color: B.textMuted, marginBottom: 16, lineHeight: 1.6 }}>
        Imagens ópticas indisponíveis <span style={{ color: B.textSub }}>(cobertura de nuvens)</span>.{" "}
        Análise exclusiva via Sentinel-1 SAR — penetra nuvens, opera à noite.
      </div>
      <ZScoreGauge zscore={rviZ} rviMean={rvi}/>
      <div style={{ background: `${nc}11`, border: `1px solid ${nc}33`, borderRadius: 10, padding: "10px 14px", marginBottom: 12 }}>
        <div style={{ fontFamily: FONTS.exo, fontSize: 12, color: nc, lineHeight: 1.6 }}>{msg}</div>
      </div>
      <SparklineChart data={rviSeries} color={B.radarPurple} label="RVI — EVOLUÇÃO (30D)"/>
    </div>
  );
}

/* ─── SPARKLINE ──────────────────────────────────────────────────────────────*/
function SparklineChart({ data, color = "#00b4d8", label = "EVOLUÇÃO (30D)" }) {
  if (!data || data.length < 2) return (
    <div style={{ marginTop: 14, borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ fontSize: 8, color: B.textSub, fontFamily: FONTS.mono, letterSpacing: 1.5 }}>{label}</div>
        <div style={{ fontSize: 8, color: B.textMuted, fontFamily: FONTS.mono }}>AGUARDANDO</div>
      </div>
      <div style={{ height: 40, background: "rgba(255,255,255,0.02)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontSize: 9, color: B.textMuted, fontFamily: FONTS.mono }}>Série temporal indisponível</span>
      </div>
    </div>
  );
  const sm  = data.map((v, i, a) => { const s = a.slice(Math.max(0,i-2),i+1); return s.reduce((x,y)=>x+y,0)/s.length; });
  const mn  = Math.min(...sm), mx = Math.max(...sm), rng = mx - mn || 1;
  const W = 280, H = 40;
  const pts = sm.map((v,i) => `${(i/(sm.length-1))*W},${H-((v-mn)/rng)*H}`).join(" ");
  const ly  = H - ((sm[sm.length-1]-mn)/rng)*H;
  return (
    <div style={{ marginTop: 14, borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 8, color: B.textSub, fontFamily: FONTS.mono, letterSpacing: 1.5 }}>{label}</div>
        <div style={{ fontSize: 8, color, fontFamily: FONTS.mono }}>SMA-3</div>
      </div>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} style={{ overflow: "visible" }}>
        <polyline fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" points={pts} style={{ filter: `drop-shadow(0 0 3px ${color}80)` }}/>
        <circle cx={W} cy={ly} r="3" fill={color} style={{ filter: `drop-shadow(0 0 4px ${color})` }}/>
      </svg>
    </div>
  );
}

/* ─── LEAFLET MAP ────────────────────────────────────────────────────────────*/
function LeafletMap({ onPolygonDrawn, drawnCoords }) {
  const mapRef = useRef(null), mapi = useRef(null);
  const [dm, setDm] = useState(false), [cnt, setCnt] = useState(drawnCoords?.length||0), [lyr, setLyr] = useState("sat");
  const poly = useRef(null), pts = useRef([]), mkrs = useRef([]);

  useEffect(() => {
    if (mapi.current) return;
    (async () => {
      if (!document.getElementById("lf-css")) { const c = document.createElement("link"); c.id="lf-css"; c.rel="stylesheet"; c.href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"; document.head.appendChild(c); }
      if (!window.L) await new Promise(r => { const s = document.createElement("script"); s.src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"; s.onload=r; document.head.appendChild(s); });
      const L = window.L, map = L.map(mapRef.current,{zoomControl:false}).setView([-14.235,-51.925],4);
      const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{attribution:"© Esri"});
      const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{attribution:"© OSM"});
      sat.addTo(map); map._sat=sat; map._osm=osm; map._curL="sat";
      L.control.zoom({position:"bottomright"}).addTo(map);
      mapi.current = map; setTimeout(()=>map.invalidateSize(),100);
    })();
  }, []);

  const toggleLayer = () => {
    const m = mapi.current; if (!m) return;
    if (m._curL==="sat") { m.removeLayer(m._sat); m._osm.addTo(m); m._curL="street"; setLyr("street"); }
    else { m.removeLayer(m._osm); m._sat.addTo(m); m._curL="sat"; setLyr("sat"); }
  };
  const startDraw = () => {
    const map=mapi.current; if(!map||!window.L) return; const L=window.L;
    mkrs.current.forEach(m=>map.removeLayer(m)); if(poly.current) map.removeLayer(poly.current);
    pts.current=[]; mkrs.current=[]; setCnt(0); setDm(true); map.getContainer().style.cursor="crosshair";
    const onClick = e => {
      pts.current.push([e.latlng.lat,e.latlng.lng]);
      mkrs.current.push(L.circleMarker(e.latlng,{radius:5,color:B.teal,fillColor:B.teal,fillOpacity:1,weight:2}).addTo(map));
      if(pts.current.length>1){if(poly.current)map.removeLayer(poly.current);poly.current=L.polyline(pts.current,{color:B.teal,weight:2,dashArray:"6 4"}).addTo(map);}
      setCnt(pts.current.length);
    };
    map.on("click",onClick); map._onClick=onClick;
  };
  const finishDraw = () => {
    const map=mapi.current; if(!map||!window.L||pts.current.length<3) return; const L=window.L;
    map.off("click",map._onClick); map.getContainer().style.cursor=""; setDm(false);
    mkrs.current.forEach(m=>map.removeLayer(m)); if(poly.current) map.removeLayer(poly.current);
    poly.current=L.polygon(pts.current,{color:B.teal,fillColor:B.teal,fillOpacity:0.18,weight:2}).addTo(map);
    map.fitBounds(poly.current.getBounds(),{padding:[20,20]});
    onPolygonDrawn([...pts.current,pts.current[0]].map(([la,ln])=>[ln,la]));
    setCnt(pts.current.length);
  };
  const clearDraw = () => {
    const map=mapi.current; if(!map) return;
    if(map._onClick) map.off("click",map._onClick);
    mkrs.current.forEach(m=>map.removeLayer(m));
    if(poly.current){map.removeLayer(poly.current);poly.current=null;}
    pts.current=[]; mkrs.current=[]; map.getContainer().style.cursor=""; setDm(false); setCnt(0); onPolygonDrawn([]);
  };
  const MB = ({label,onClick,disabled,clr=B.teal}) => (
    <button onClick={onClick} disabled={disabled} style={{background:"rgba(3,8,15,0.90)",backdropFilter:"blur(10px)",border:`1px solid ${disabled?B.border:clr}77`,color:disabled?B.textMuted:clr,borderRadius:8,padding:"5px 10px",fontSize:9.5,cursor:disabled?"not-allowed":"pointer",fontFamily:FONTS.mono}}>{label}</button>
  );
  return (
    <div style={{position:"relative",borderRadius:14,overflow:"hidden",border:"1px solid "+B.border}}>
      <div ref={mapRef} style={{width:"100%",height:210}}/>
      <div style={{position:"absolute",top:8,left:8,zIndex:1000}}><MB label={lyr==="sat"?"🗺 MAPA":"🛰 SAT"} onClick={toggleLayer} clr={B.textSub}/></div>
      <div style={{position:"absolute",top:8,right:8,zIndex:1000,display:"flex",gap:5}}>
        {!dm?<MB label="✏ DESENHAR" onClick={startDraw}/>:<><MB label={`✓ FECHAR (${cnt})`} onClick={finishDraw} disabled={cnt<3}/><MB label="✕" onClick={clearDraw} clr={B.red}/></>}
      </div>
      {dm&&<div style={{position:"absolute",bottom:8,left:"50%",transform:"translateX(-50%)",zIndex:1000,background:"rgba(3,8,15,0.90)",border:`1px solid ${B.teal}44`,borderRadius:8,padding:"4px 12px",fontSize:9.5,color:B.teal,fontFamily:FONTS.mono,whiteSpace:"nowrap"}}>Clique para adicionar pontos</div>}
      {cnt>0&&!dm&&<div style={{position:"absolute",bottom:8,left:8,zIndex:1000,background:"rgba(3,8,15,0.90)",border:`1px solid ${B.green}44`,borderRadius:8,padding:"4px 10px",fontSize:9.5,color:B.green,fontFamily:FONTS.mono}}>✓ {cnt} vértices</div>}
    </div>
  );
}

/* ─── HOME ───────────────────────────────────────────────────────────────────*/
function HomeView({ setView, farms, logs, setFarms }) {
  const farm      = farms[0] || null;
  const alert     = getAlertLevel(farm);
  const radarMode = farm && farm.ndvi == null && farm.nbr == null && farm.rvi != null;
  const [showN, setShowN] = useState(false);

  const rviZ      = farm ? calcZScore(farm.rvi_series) : null;
  const rviColor  = rviZ === null ? B.teal : rviZ < -1.5 ? B.red : rviZ < -1.0 ? B.orange : B.teal;
  const rviSub    = rviZ !== null ? `Z=${rviZ.toFixed(2)}` : null;
  const ndviColor = farm?.ndvi != null ? (farm.ndvi >= 0.6 ? B.green : farm.ndvi >= 0.4 ? B.orange : B.red) : undefined;
  const nbrColor  = farm?.nbr  != null ? (farm.nbr  >= 0.3 ? B.green : farm.nbr  >= 0.1 ? B.orange : B.red) : undefined;

  /* polling enquanto pending */
  useEffect(() => {
    if (!farm || getAlertLevel(farm) !== "pending") return;
    let n = 0;
    const p = setInterval(async () => {
      if (++n > 13) { clearInterval(p); return; }
      try {
        const r = await fetch(CLOUD_FUNCTION_URL, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({email:farm.email,nome_fazenda:farm.name,coordinates:farm.coords}) });
        const j = await r.json();
        if (!r.ok || j.error || !j.data) return;
        if (j.data.ndvi_mean==null && j.data.nbr_mean==null && j.data.rvi_mean==null) return;
        setFarms(prev => applyEEData(prev, j.data)); clearInterval(p);
      } catch {}
    }, 45_000);
    return () => clearInterval(p);
  }, [farm?.name]);

  return (
    <div style={S.scrollView}>
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <Logo size={36}/>
          <div>
            <div style={{fontFamily:FONTS.exo,fontSize:18,fontWeight:800,color:B.textPrimary,letterSpacing:3}}>AGROSCAN</div>
            <div style={{fontFamily:FONTS.mono,fontSize:8,color:B.teal,letterSpacing:2.5}}>PAINEL DE CONTROLE</div>
          </div>
        </div>
        <div style={{position:"relative"}}>
          <div onClick={()=>setShowN(!showN)} style={{background:showN?B.surfaceHi:B.surface,border:`1px solid ${showN?B.teal:B.border}`,borderRadius:12,width:40,height:40,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:17}}>🔔</div>
          {alert==="red"&&<div style={{position:"absolute",top:-3,right:-3,width:11,height:11,background:B.red,borderRadius:"50%",border:"2px solid "+B.bg0,animation:"agropulse 1.2s ease-in-out infinite"}}/>}
          {showN&&(
            <div style={{position:"absolute",top:50,right:0,width:260,background:B.surfaceHi,border:`1px solid ${B.borderHi}`,borderRadius:14,padding:14,zIndex:1000,boxShadow:"0 10px 40px rgba(0,0,0,0.8)"}}>
              <div style={{fontSize:11,color:B.textPrimary,fontFamily:FONTS.exo,fontWeight:700,marginBottom:10,borderBottom:`1px solid ${B.border}`,paddingBottom:8}}>Últimas Notificações</div>
              {logs.slice(0,3).map(l=>(
                <div key={l.id} style={{marginBottom:10,paddingBottom:8,borderBottom:"1px solid rgba(255,255,255,0.03)"}}>
                  <div style={{fontSize:9,color:B.teal,fontFamily:FONTS.mono,marginBottom:2}}>{l.time}</div>
                  <div style={{fontSize:11,color:B.textSub,fontFamily:FONTS.exo,lineHeight:1.4}}>{l.text}</div>
                </div>
              ))}
              {logs.length===0&&<div style={{fontSize:11,color:B.textMuted}}>Nenhum alerta recente.</div>}
            </div>
          )}
        </div>
      </div>

      {farm ? (
        <>
          {/* Farm header */}
          <div style={{background:`linear-gradient(145deg,${B.surface},${B.surfaceHi})`,border:"1px solid "+B.borderHi,borderTop:`2px solid ${radarMode?B.radarPurple:B.teal}`,borderRadius:18,padding:18,marginBottom:14,position:"relative",overflow:"hidden"}}>
            <OrbitDeco/>
            <div style={{position:"relative",zIndex:1}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                <div>
                  <div style={{fontSize:8.5,color:radarMode?B.radarPurple:B.teal,letterSpacing:2.5,fontFamily:FONTS.mono,marginBottom:3}}>
                    {radarMode?"📡 MODO RADAR ATIVO":"● MONITORAMENTO ATIVO"}
                  </div>
                  <div style={{fontFamily:FONTS.exo,fontSize:20,fontWeight:800,color:B.textPrimary}}>{farm.name}</div>
                  <div style={{fontSize:9.5,color:B.textMuted,fontFamily:FONTS.mono,marginTop:2}}>📍 {farm.lastCoord}</div>
                  {farm.opticalSource && !["Sentinel-2 (cloud<30%)",null,undefined].includes(farm.opticalSource) && farm.opticalSource !== "indisponivel" && (
                    <div style={{fontSize:8.5,color:B.orange,fontFamily:FONTS.mono,marginTop:3}}>📷 Fallback: {farm.opticalSource}</div>
                  )}
                </div>
                <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:6}}>
                  <AlertBadge level={alert}/>
                  {alert==="pending"&&(
                    <div style={{padding:"7px 10px",background:"rgba(0,180,216,0.06)",border:"1px solid #007a9a44",borderRadius:10,fontSize:9.5,color:B.textMuted,fontFamily:FONTS.exo,lineHeight:1.6,textAlign:"right"}}>
                      ⏳ Earth Engine processando.<br/><b style={{color:B.teal}}>Notificação em até 10 min.</b>
                    </div>
                  )}
                </div>
              </div>

              {/* Métricas — null → "—" */}
              <div style={{display:"flex",gap:8,marginBottom:10}}>
                <Metric label="NDVI" value={farm.ndvi} color={ndviColor}/>
                <Metric label="NBR"  value={farm.nbr}  color={nbrColor}/>
                <Metric label="RVI"  value={farm.rvi}  color={rviColor} sub={rviSub}/>
              </div>

              {/* Precipitação */}
              <div style={S.infoPill}>
                {[
                  ["🌧 7d",  farm.rain7d  != null ? `${farm.rain7d}${farm.dataGap?"mm*":"mm"}`  : "—"],
                  ["30d",    farm.rain30d != null ? `${farm.rain30d}${farm.dataGap?"mm*":"mm"}` : "—"],
                  ["📡 Sat", radarMode?"Sentinel-1":"S-2/L8/L9"],
                ].map(([k,v])=>(
                  <span key={k} style={{fontSize:10,color:B.textSub,fontFamily:FONTS.mono}}>
                    {k}: <b style={{color:radarMode?B.radarPurple:B.teal}}>{v}</b>
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Conteúdo principal: Modo Radar ou óptico + Z-Score */}
          {radarMode ? (
            <RadarModeCard rvi={farm.rvi} rviZ={rviZ} rviSeries={farm.rvi_series}/>
          ) : (
            <>
              {farm.rvi != null && <ZScoreGauge zscore={rviZ} rviMean={farm.rvi}/>}
              <div style={{background:B.surface,border:"1px solid "+B.border,borderRadius:16,padding:16,marginBottom:14}}>
                <SparklineChart data={farm.ndvi_series} color={B.green}       label="NDVI — EVOLUÇÃO (30D)"/>
                <SparklineChart data={farm.rvi_series}  color={B.radarPurple} label="RVI — EVOLUÇÃO (30D)"/>
              </div>
            </>
          )}
        </>
      ) : (
        <div style={{background:B.surface,border:`2px dashed ${B.border}`,borderRadius:18,padding:30,textAlign:"center",marginBottom:14}}>
          <Logo size={54}/>
          <div style={{fontFamily:FONTS.exo,fontSize:16,fontWeight:700,color:B.textPrimary,margin:"14px 0 8px"}}>Nenhuma fazenda ativa</div>
          <div style={{fontSize:11,color:B.textMuted,marginBottom:18,lineHeight:1.7,fontFamily:FONTS.exo}}>Cadastre sua propriedade para iniciar o monitoramento orbital via satélite</div>
          <button onClick={()=>setView("registration")} style={{background:`linear-gradient(135deg,${B.blue},${B.teal})`,border:"none",borderRadius:12,padding:"10px 22px",color:"#fff",cursor:"pointer",fontFamily:FONTS.exo,fontWeight:700,fontSize:12}}>+ CADASTRAR FAZENDA</button>
        </div>
      )}

      <div style={S.sectionLabel}>AÇÕES RÁPIDAS</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:18}}>
        {[{icon:"➕",label:"Nova Fazenda",view:"registration",accent:B.green},{icon:"📖",label:"Guia Técnico",view:"guide",accent:B.teal}].map(a=>(
          <button key={a.view} onClick={()=>setView(a.view)} style={{background:B.surface,border:"1px solid "+B.border,borderRadius:14,padding:"16px 10px",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:8,width:"100%"}}
            onMouseEnter={e=>e.currentTarget.style.borderColor=a.accent} onMouseLeave={e=>e.currentTarget.style.borderColor=B.border}>
            <span style={{fontSize:26}}>{a.icon}</span>
            <span style={{fontFamily:FONTS.exo,fontSize:11,fontWeight:600,color:B.textSub}}>{a.label}</span>
          </button>
        ))}
      </div>

      <div style={S.sectionLabel}>LOG DE ATIVIDADES</div>
      <div style={S.card}>
        {logs.slice(0,10).map((log,i)=>{
          const dot={success:B.green,warning:B.orange,error:B.red,info:B.teal}[log.type]||B.teal;
          return (
            <div key={log.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderBottom:i<9?"1px solid "+B.bg1:"none",background:i%2?"rgba(255,255,255,0.01)":"transparent"}}>
              <div style={{width:6,height:6,borderRadius:"50%",background:dot,flexShrink:0}}/>
              <div style={{flex:1,fontSize:11,color:B.textSub,fontFamily:FONTS.exo}}>{log.text}</div>
              <div style={{fontSize:9.5,color:B.textMuted,fontFamily:FONTS.mono,flexShrink:0}}>{log.time}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── REGISTRATION ───────────────────────────────────────────────────────────*/
function RegistrationView({ setView, onRegister }) {
  const [email,setEmail]=useState(""), [farm,setFarm]=useState(""), [coords,setCoords]=useState([]), [emailErr,setEmailErr]=useState(""), [status,setStatus]=useState({loading:false,message:"",type:""});
  const valid = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  const ok    = valid(email) && farm.trim() && coords.length>=3 && !status.loading;

  const go = async () => {
    if (!valid(email)){setEmailErr("Formato inválido");return;}
    if (!farm.trim()||coords.length<3){setStatus({loading:false,message:"Preencha todos os campos.",type:"error"});return;}
    setStatus({loading:true,message:"Solicitando permissão de notificações...",type:""});
    const tok = await getFCMToken();
    const nf  = {name:farm.trim(),email,coords,ndvi:null,nbr:null,rvi:null,rain7d:null,rain30d:null,dataGap:false,opticalSource:null,ndvi_series:[],rvi_series:[],lastCoord:coords[0]?`${Math.abs(coords[0][1]).toFixed(4)}°S, ${Math.abs(coords[0][0]).toFixed(4)}°W`:""};
    onRegister(nf,tok);
    setStatus({loading:false,message:tok?"Cadastro realizado! Notificação push quando os dados ficarem prontos.":"Cadastro realizado! Relatório no e-mail em até 10 minutos.",type:"success"});
    setTimeout(()=>setView("home"),3500);
  };

  const SC={success:{bg:B.greenGlow,border:B.green,color:B.green,icon:"✓"},error:{bg:"rgba(239,83,80,0.1)",border:B.red,color:B.red,icon:"⚠"},loading:{bg:B.tealGlow2,border:B.teal,color:B.teal,icon:"⏳"}};
  const sc=SC[status.type||(status.loading?"loading":"error")];

  return (
    <div style={S.scrollView}>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:22}}>
        <button onClick={()=>setView("home")} style={S.backBtn}>←</button>
        <div>
          <div style={{fontFamily:FONTS.exo,fontSize:17,fontWeight:800,color:B.textPrimary}}>Nova Propriedade</div>
          <div style={{fontFamily:FONTS.mono,fontSize:8,color:B.teal,letterSpacing:2}}>GEORREFERENCIAMENTO DE TALHÃO</div>
        </div>
      </div>
      {[{lbl:"E-MAIL PARA ALERTAS *",ph:"produtor@fazenda.com.br",val:email,set:v=>{setEmail(v);setEmailErr("");},t:"email",err:emailErr},{lbl:"NOME DA PROPRIEDADE *",ph:"Ex: Fazenda Santa Fé",val:farm,set:setFarm,t:"text",err:""}].map(f=>(
        <div key={f.lbl} style={{marginBottom:14}}>
          <label style={S.label}>{f.lbl}</label>
          <input value={f.val} onChange={e=>f.set(e.target.value)} placeholder={f.ph} type={f.t} onBlur={()=>f.t==="email"&&f.val&&!valid(f.val)&&setEmailErr("Formato inválido")} style={S.inputBase(f.err)}/>
          {f.err&&<div style={{fontSize:10,color:B.red,marginTop:4}}>{f.err}</div>}
        </div>
      ))}
      <div style={{marginBottom:14}}>
        <label style={S.label}>DELIMITAÇÃO DO TALHÃO *</label>
        <LeafletMap onPolygonDrawn={setCoords} drawnCoords={coords}/>
        <div style={{fontSize:10,color:B.textMuted,marginTop:5}}>DESENHAR → clique nos pontos → FECHAR para confirmar</div>
      </div>
      {coords.length>0&&(
        <div style={{background:B.bg0,border:"1px solid "+B.border,borderRadius:10,padding:10,marginBottom:14}}>
          <div style={{...S.monoXs,marginBottom:4}}>GeoJSON GERADO</div>
          <div style={{fontFamily:FONTS.mono,fontSize:9,color:B.green,wordBreak:"break-all"}}>{`{"type":"Polygon","coordinates":[[${coords.slice(0,2).map(c=>`[${c[0]?.toFixed(4)},${c[1]?.toFixed(4)}]`).join(",")},...]]}`}</div>
        </div>
      )}
      {status.message&&(
        <div style={{background:sc.bg,border:`1px solid ${sc.border}66`,borderRadius:12,padding:"11px 14px",marginBottom:14,color:sc.color,fontFamily:FONTS.exo,fontSize:12,display:"flex",alignItems:"center",gap:8}}>
          <span>{sc.icon}</span>{status.message}
        </div>
      )}
      <button onClick={go} disabled={!ok} style={{width:"100%",background:ok?`linear-gradient(135deg,${B.blue},${B.teal})`:B.surface,border:`1px solid ${ok?B.teal:B.border}`,borderRadius:14,padding:"14px",color:ok?"#fff":B.textMuted,cursor:ok?"pointer":"not-allowed",fontFamily:FONTS.exo,fontWeight:700,fontSize:13,letterSpacing:2}}>
        🛰 {status.loading?"ENVIANDO...":"ATIVAR AGROSCAN"}
      </button>
    </div>
  );
}

/* ─── GUIDE ──────────────────────────────────────────────────────────────────*/
function GuideView({ setView }) {
  const [page,setPage]=useState(0);
  const cur=GUIDE_PAGES[page];
  return (
    <div style={{height:"100%",display:"flex",flexDirection:"column",background:`linear-gradient(160deg,${cur.grad[0]},${cur.grad[1]})`,transition:"background 0.5s",padding:"calc(env(safe-area-inset-top, 20px) + 16px) 20px calc(env(safe-area-inset-bottom, 16px) + 80px)"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:26}}>
        <button onClick={()=>setView("home")} style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"6px 14px",color:"rgba(255,255,255,0.65)",cursor:"pointer",fontSize:12,fontFamily:FONTS.exo,fontWeight:600}}>← Voltar</button>
        <div style={{fontFamily:FONTS.mono,fontSize:9,color:"rgba(255,255,255,0.3)",letterSpacing:2}}>{page+1} / {GUIDE_PAGES.length}</div>
        <div style={{width:64}}/>
      </div>
      <div style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center",paddingBottom:12}}>
        <div style={{fontSize:54,marginBottom:16}}>{cur.emoji}</div>
        <div style={{fontFamily:FONTS.exo,fontSize:26,fontWeight:800,color:"#fff",letterSpacing:3,textTransform:"uppercase"}}>{cur.title}</div>
        <div style={{fontFamily:FONTS.mono,fontSize:9.5,color:cur.accent,letterSpacing:3,textTransform:"uppercase",margin:"4px 0 14px"}}>{cur.subtitle}</div>
        <div style={{fontFamily:FONTS.exo,fontSize:13,lineHeight:1.8,color:"rgba(255,255,255,0.7)",maxWidth:285,marginBottom:20}}>{cur.content}</div>
        {cur.ranges&&(
          <div style={{width:"100%",maxWidth:295,display:"flex",flexDirection:"column",gap:7,marginBottom:18}}>
            {cur.ranges.map(r=>(
              <div key={r.label} style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"rgba(255,255,255,0.05)",borderRadius:10,padding:"8px 14px"}}>
                <span style={{fontFamily:FONTS.mono,fontSize:12,color:r.color}}>{r.label}</span>
                <span style={{fontFamily:FONTS.exo,fontSize:12,color:"rgba(255,255,255,0.55)"}}>{r.status}</span>
                <div style={{width:8,height:8,borderRadius:"50%",background:r.color,boxShadow:`0 0 6px ${r.color}`}}/>
              </div>
            ))}
          </div>
        )}
        <div style={{background:"rgba(255,255,255,0.05)",border:`1px solid ${cur.accent}44`,borderLeft:`3px solid ${cur.accent}`,borderRadius:10,padding:"10px 14px",maxWidth:295,textAlign:"left"}}>
          <div style={{fontSize:8.5,color:cur.accent,letterSpacing:2,textTransform:"uppercase",fontFamily:FONTS.mono,marginBottom:4}}>💡 DICA DE CAMPO</div>
          <div style={{fontSize:12,color:"rgba(255,255,255,0.6)",fontFamily:FONTS.exo,lineHeight:1.6}}>{cur.tip}</div>
        </div>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:20}}>
        {[{show:page>0,label:"←",fn:()=>setPage(p=>p-1)},{show:page<GUIDE_PAGES.length-1,label:"→",fn:()=>setPage(p=>p+1)}].map((b,i)=>(
          <button key={i} onClick={b.fn} disabled={!b.show} style={{background:b.show?"rgba(255,255,255,0.1)":"transparent",border:"1px solid rgba(255,255,255,0.12)",borderRadius:12,padding:"10px 18px",color:b.show?"#fff":"transparent",cursor:b.show?"pointer":"default",fontSize:16}}>{b.label}</button>
        ))}
        <div style={{display:"flex",gap:6}}>
          {GUIDE_PAGES.map((_,i)=><button key={i} onClick={()=>setPage(i)} style={{width:i===page?24:8,height:8,borderRadius:4,background:i===page?cur.accent:"rgba(255,255,255,0.2)",border:"none",cursor:"pointer",transition:"all 0.3s",padding:0}}/>)}
        </div>
      </div>
    </div>
  );
}

/* ─── SETTINGS ───────────────────────────────────────────────────────────────*/
function SettingsView({ farms }) {
  const farm = farms[0];
  const InfoCard = ({rows}) => (
    <div style={S.card}>
      {rows.map((r,i)=>(
        <div key={i} style={S.cardRow(i===rows.length-1)}>
          <span style={{fontSize:12,color:B.textMuted,fontFamily:FONTS.exo}}>{r.label}</span>
          <span style={{fontSize:r.mono?10:12,color:r.color||B.textSub,fontFamily:r.mono?FONTS.mono:FONTS.exo,maxWidth:"60%",textAlign:"right",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.value}</span>
        </div>
      ))}
    </div>
  );
  return (
    <div style={S.scrollView}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
        <Logo size={30}/><div style={{fontFamily:FONTS.exo,fontSize:17,fontWeight:800,color:B.textPrimary}}>Configurações</div>
      </div>
      <div style={S.sectionLabel}>CONTA</div>
      <InfoCard rows={[{label:"E-mail",value:farm?.email||"—"},{label:"Propriedade",value:farm?.name||"—"},{label:"Status",value:farm?"Ativo":"Sem cadastro",color:farm?B.green:B.textMuted}]}/>
      <div style={S.sectionLabel}>SATÉLITES & FONTES</div>
      <InfoCard rows={[{label:"🛰 Sentinel-2",value:"Óptico · ESA Copernicus",color:B.green},{label:"📡 Sentinel-1",value:"Radar SAR · VV + VH",color:B.teal},{label:"🔭 Landsat 8/9",value:"Fallback óptico · USGS",color:B.orange},{label:"🌍 MODIS",value:"Fallback final · NDVI 250m",color:B.textSub},{label:"🌧 CHIRPS+GPM",value:"Precipitação · NASA",color:B.teal}]}/>
      <div style={S.sectionLabel}>ALGORITMOS</div>
      <InfoCard rows={[{label:"NDVI/NBR",value:"S2 → Landsat → MODIS",mono:true},{label:"RVI",value:"4×VH / (VV + VH)",mono:true,color:B.teal},{label:"Alerta RVI",value:"Z-Score < −1.5σ",mono:true,color:B.orange},{label:"Modo Radar",value:"ndvi=null + nbr=null",mono:true,color:B.radarPurple}]}/>
      <div style={S.sectionLabel}>INFRAESTRUTURA GCP</div>
      <InfoCard rows={[{label:"Cloud Function",value:"Python 3.10 · v2",mono:true},{label:"Scheduler",value:"0 6 * * * (06h)",mono:true,color:B.teal},{label:"Banco",value:"Firestore NoSQL",mono:true},{label:"Segredos",value:"GCP Secret Manager",mono:true}]}/>
      <div style={{marginTop:28,textAlign:"center",paddingBottom:8}}>
        <Logo size={30}/>
        <div style={{fontFamily:FONTS.mono,fontSize:8,color:B.textMuted,letterSpacing:2,marginTop:8}}>AGROSCAN v3.0 — APK BUILD · UFABC</div>
      </div>
    </div>
  );
}

/* ─── BOTTOM NAV ─────────────────────────────────────────────────────────────*/
function BottomNav({ view, setView }) {
  const tabs=[{id:"home",icon:"⌂",label:"Home"},{id:"registration",icon:"+",label:"Cadastro"},{id:"guide",icon:"📖",label:"Guia"},{id:"settings",icon:"⚙",label:"Config"}];
  return (
    <div style={{position:"absolute",bottom:0,left:0,right:0,height:"calc(68px + env(safe-area-inset-bottom, 0px))",paddingBottom:"env(safe-area-inset-bottom, 0px)",background:"rgba(3,8,15,0.97)",backdropFilter:"blur(20px)",borderTop:`1px solid ${B.border}`,display:"flex",alignItems:"flex-start",justifyContent:"space-around",paddingTop:6,zIndex:100}}>
      {tabs.map(t=>{
        const active=view===t.id;
        return (
          <button key={t.id} onClick={()=>setView(t.id)} style={{background:"none",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:2,padding:"6px 12px"}}>
            <div style={{width:38,height:38,borderRadius:11,display:"flex",alignItems:"center",justifyContent:"center",fontSize:19,transition:"all 0.25s",background:active?B.tealGlow:"transparent",border:active?`1px solid ${B.teal}44`:"1px solid transparent",color:active?B.teal:B.textMuted}}>{t.icon}</div>
            <span style={{fontSize:8,color:active?B.teal:B.textMuted,fontFamily:FONTS.mono,letterSpacing:1}}>{t.label.toUpperCase()}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ─── ROOT APP ───────────────────────────────────────────────────────────────*/
export default function App() {
  const [view,setView]=useState("home"), [farms,setFarms]=useState([]), [logs,setLogs]=useState([{id:Date.now(),time:"00:00",type:"info",text:"Sistema iniciado. Aguardando cadastro de fazenda."}]);

  useEffect(()=>{
    const sf=load(SK.farms,[]);
    setFarms(sf);
    setLogs(load(SK.logs,[{id:Date.now(),time:"00:00",type:"info",text:"Sistema iniciado."}]));

    /* recovery: busca resultado salvo se app foi fechado durante pending */
    const p=sf[0];
    if (p?.farmId && p.rvi==null && p.ndvi==null) {
      fetch(CLOUD_FUNCTION_STATUS,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({farm_id:p.farmId})})
        .then(r=>r.json()).then(j=>{if(j.status==="ready"&&j.data)setFarms(prev=>applyEEData(prev,j.data));}).catch(()=>{});
    }
    if("serviceWorker"in navigator) navigator.serviceWorker.register("/firebase-messaging-sw.js").catch(()=>{});
  },[]);

  useEffect(()=>{save(SK.farms,farms);},[farms]);
  useEffect(()=>{save(SK.logs,logs);},[logs]);

  const addLog=useCallback((text,type="info")=>{
    const time=new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});
    setLogs(prev=>[{id:Date.now(),time,type,text},...prev].slice(0,10));
  },[]);

  const handleRegister=useCallback((farm,fcmToken)=>{
    setFarms(prev=>[farm,...prev]);
    addLog(`Fazenda "${farm.name}" cadastrada`,"success");
    addLog(`Relatório enviado para ${farm.email}`,"info");

    fetch(CLOUD_FUNCTION_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:farm.email,nome_fazenda:farm.name,coordinates:farm.coords,fcm_token:fcmToken})})
      .then(r=>r.json())
      .then(json=>{
        if(!json?.data) return;
        setFarms(prev=>[{...applyEEData(prev,json.data)[0],...(json.farm_id?{farmId:json.farm_id}:{})},...prev.slice(1)]);
        addLog(`Dados orbitais recebidos para "${farm.name}"`,"success");
      }).catch(()=>{});
  },[addLog]);

  return (
    <>
      <FontLoader/>
      <style>{`
        @keyframes agropulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(1.5)}}
        *{box-sizing:border-box;margin:0;padding:0}
        html,body,#root{height:100%;background:${B.bg0}}
        ::-webkit-scrollbar{width:2px}
        ::-webkit-scrollbar-thumb{background:${B.border};border-radius:2px}
        input:focus{outline:none!important;border-color:${B.teal}!important;box-shadow:0 0 0 3px ${B.tealGlow}!important}
        *{-webkit-user-select:none;user-select:none}
        input,textarea{-webkit-user-select:text;user-select:text}
      `}</style>
      <div style={{position:"relative",width:"100vw",height:"100vh",background:B.bg0,overflow:"hidden",backgroundImage:`radial-gradient(ellipse at 20% 15%,rgba(0,100,180,0.08) 0%,transparent 55%),radial-gradient(ellipse at 80% 85%,rgba(0,150,200,0.06) 0%,transparent 55%)`}}>
        <div style={{position:"absolute",inset:0}}>
          {view==="home"         && <HomeView setView={setView} farms={farms} logs={logs} setFarms={setFarms}/>}
          {view==="registration" && <RegistrationView setView={setView} onRegister={handleRegister}/>}
          {view==="guide"        && <GuideView setView={setView}/>}
          {view==="settings"     && <SettingsView farms={farms}/>}
        </div>
        <BottomNav view={view} setView={setView}/>
      </div>
    </>
  );
}