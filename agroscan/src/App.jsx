import { useState, useEffect, useRef, useCallback } from "react";

/*
 ╔══════════════════════════════════════════════════════════════╗
 ║  AgroScan v2.2 — APK BUILD                                  ║
 ║  Diferenças em relação à v2.1 (demo web):                   ║
 ║  • Phone frame REMOVIDO — ocupa 100% da tela nativa         ║
 ║  • Safe-area via CSS env() para notch/barra de status       ║
 ║  • Viewport configurado para Capacitor                      ║
 ║  • window.storage substituído por localStorage              ║
 ║    (Capacitor expõe localStorage no WebView Android)        ║
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

/* ─── STYLE TOKENS ───────────────────────────────────────────────────────── */
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
  // ✅ v2.2: scrollView usa safe-area para respeitar notch/barra nativa
  scrollView: {
    height: "100%",
    overflowY: "auto",
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
    l.id = "agro-fonts";
    l.href = "https://fonts.googleapis.com/css2?family=Exo+2:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,700&family=Share+Tech+Mono&display=swap";
    l.rel = "stylesheet";
    document.head.appendChild(l);
  }, []);
  return null;
};

const CLOUD_FUNCTION_URL = "https://us-central1-agroscan-ipe.cloudfunctions.net/agroscan_monitor";

const INITIAL_LOGS = [
  { id: 1, time: "06:12", type: "success", text: "Processamento Sentinel-2 concluído" },
  { id: 2, time: "06:08", type: "info",    text: "CHIRPS: coleta de precipitação OK" },
  { id: 3, time: "05:55", type: "warning", text: "Cobertura de nuvens 28% — limiar atingido" },
  { id: 4, time: "05:40", type: "success", text: "Sentinel-1 Radar — RVI processado" },
  { id: 5, time: "00:00", type: "info",    text: "Varredura global — Cloud Scheduler ativado" },
];

const GUIDE_PAGES = [
  {
    id: "intro", title: "Manual AgroScan", subtitle: "Satélites a serviço do campo",
    grad: ["#050d1a", "#0a1e3a"], accent: B.teal, emoji: "🛰️",
    content: "O AgroScan combina dados da NASA e da ESA para entregar inteligência orbital diariamente. Três fontes de satélite garantem diagnóstico preciso independente das condições climáticas.",
    tip: "Dados atualizados diariamente às 06h — horário de Brasília",
  },
  {
    id: "ndvi", title: "NDVI", subtitle: "Vigor Vegetativo",
    grad: ["#061a0d", "#0b2e14"], accent: B.green, emoji: "🌿",
    content: "Calculado com bandas infravermelho (B8) e vermelho (B4) do Sentinel-2. É o termômetro da sua lavoura — detecta estresse antes que seja visível a olho nu.",
    ranges: [
      { label: "> 0.6", status: "Excelente", color: B.green },
      { label: "0.4–0.6", status: "Atenção",   color: B.orange },
      { label: "< 0.4", status: "Crítico",    color: B.red },
    ],
    tip: "Verifique adubação e pragas quando NDVI < 0.4 com solo úmido",
  },
  {
    id: "nbr", title: "NBR", subtitle: "Risco de Incêndio",
    grad: ["#1a0900", "#2e1400"], accent: B.orange, emoji: "🔥",
    content: "Usa bandas NIR (B8) e SWIR (B12). Valores baixos indicam vegetação seca e vulnerável. Monitore aceiros e ative protocolos preventivos.",
    ranges: [
      { label: "> 0.3", status: "Seguro",         color: B.green },
      { label: "0.1–0.3", status: "Vigilância",   color: B.orange },
      { label: "< 0.1", status: "Perigo crítico", color: B.red },
    ],
    tip: "NBR < 0.1 → Limpe aceiros e notifique a Defesa Civil imediatamente",
  },
  {
    id: "rvi", title: "RVI", subtitle: "Radar através das nuvens",
    grad: ["#030c1f", "#071a38"], accent: B.teal, emoji: "📡",
    content: "Radar Sentinel-1 (VV e VH). Atravessa nuvens e chuva para medir estrutura da planta e umidade do solo — essencial na época chuvosa.",
    ranges: [
      { label: "> 0.5", status: "Solo úmido", color: B.teal },
      { label: "0.2–0.5", status: "Adequado", color: B.green },
      { label: "< 0.2", status: "Irrigar",    color: B.orange },
    ],
    tip: "Quando satélites ópticos falham por nuvens, o radar ainda funciona",
  },
];

/* ─── PERSISTÊNCIA (localStorage — funciona no WebView do Capacitor) ─────── */
const STORAGE_KEYS = { farms: "agroscan:farms", logs: "agroscan:logs" };

function loadFromStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveToStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn("Storage error:", e);
  }
}

/* ─── HELPERS ────────────────────────────────────────────────────────────── */
function getAlertLevel(farm) {
  if (!farm) return null;
  const { ndvi = 1, nbr = 1, vv = 0 } = farm;
  if (nbr < 0.1 || ndvi < 0.3) return "red";
  if (ndvi < 0.4 || vv < -14)  return "orange";
  return "green";
}

const ALERT_CFG = {
  green:  { bg: "rgba(61,184,92,0.09)",  border: "#3db85c", dot: "#3db85c", label: "Normal"  },
  orange: { bg: "rgba(251,140,0,0.10)",  border: "#fb8c00", dot: "#fb8c00", label: "Atenção" },
  red:    { bg: "rgba(239,83,80,0.10)",  border: "#ef5350", dot: "#ef5350", label: "Crítico" },
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

function Metric({ label, value, color }) {
  return (
    <div style={S.metric}>
      <div style={{ ...S.monoXs, letterSpacing: 1.8, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: FONTS.mono, fontSize: 17, color: color || B.teal }}>
        {typeof value === "number" ? value.toFixed(3) : value}
      </div>
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
  const [drawMode, setDrawMode]   = useState(false);
  const [count, setCount]         = useState(drawnCoords?.length || 0);
  const [layerMode, setLayerMode] = useState("sat");
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
      const L = window.L;
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

/* ─── HOME ───────────────────────────────────────────────────────────────── */
function HomeView({ setView, farms, logs }) {
  const farm  = farms[0] || null;
  const alert = getAlertLevel(farm);
  
  // NOVO: Estado para controlar se o painel de notificações está aberto ou fechado
  const [showNotifs, setShowNotifs] = useState(false);

  return (
    <div style={S.scrollView}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo size={36} />
          <div>
            <div style={{ fontFamily: FONTS.exo, fontSize: 18, fontWeight: 800, color: B.textPrimary, letterSpacing: 3 }}>AGROSCAN</div>
            <div style={{ fontFamily: FONTS.mono, fontSize: 8, color: B.teal, letterSpacing: 2.5 }}>PAINEL DE CONTROLE</div>
          </div>
        </div>
        
        {/* ÁREA DO SINO ATUALIZADA */}
        <div style={{ position: "relative" }}>
          <div 
            onClick={() => setShowNotifs(!showNotifs)}
            style={{ 
              background: showNotifs ? B.surfaceHi : B.surface, 
              border: `1px solid ${showNotifs ? B.teal : B.border}`, 
              borderRadius: 12, width: 40, height: 40, display: "flex", 
              alignItems: "center", justifyContent: "center", cursor: "pointer", 
              fontSize: 17, transition: "all 0.2s" 
            }}>
            🔔
          </div>
          {alert === "red" && <div style={{ position: "absolute", top: -3, right: -3, width: 11, height: 11, background: B.red, borderRadius: "50%", border: "2px solid " + B.bg0, animation: "agropulse 1.2s ease-in-out infinite", pointerEvents: "none" }} />}
          
          {/* MENU SUSPENSO DE NOTIFICAÇÕES */}
          {showNotifs && (
            <div style={{
              position: "absolute", top: 50, right: 0, width: 260, background: B.surfaceHi,
              border: `1px solid ${B.borderHi}`, borderRadius: 14, padding: 14, zIndex: 1000,
              boxShadow: `0 10px 40px rgba(0,0,0,0.8)`
            }}>
              <div style={{ fontSize: 11, color: B.textPrimary, fontFamily: FONTS.exo, fontWeight: 700, marginBottom: 10, borderBottom: `1px solid ${B.border}`, paddingBottom: 8 }}>
                Últimas Notificações
              </div>
              {logs.slice(0, 3).map(log => (
                <div key={log.id} style={{ marginBottom: 10, borderBottom: `1px solid rgba(255,255,255,0.03)`, paddingBottom: 8 }}>
                  <div style={{ fontSize: 9, color: B.teal, fontFamily: FONTS.mono, marginBottom: 2 }}>{log.time}</div>
                  <div style={{ fontSize: 11, color: B.textSub, fontFamily: FONTS.exo, lineHeight: 1.4 }}>{log.text}</div>
                </div>
              ))}
              {logs.length === 0 && <div style={{ fontSize: 11, color: B.textMuted }}>Nenhum alerta recente.</div>}
            </div>
          )}
        </div>
      </div>

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
              <AlertBadge level={alert} />
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <Metric label="NDVI" value={farm.ndvi} color={farm.ndvi >= 0.6 ? B.green : farm.ndvi >= 0.4 ? B.orange : B.red} />
              <Metric label="NBR"  value={farm.nbr}  color={farm.nbr  >= 0.3 ? B.green : farm.nbr  >= 0.1 ? B.orange : B.red} />
              <Metric label="RVI"  value={farm.rvi}  color={B.teal} />
            </div>
            <div style={S.infoPill}>
              {[["🌧 7d", farm.rain7d + "mm"], ["30d", farm.rain30d + "mm"], ["📡 Status", "Online"]].map(([k, v]) => (
                <span key={k} style={{ fontSize: 10, color: B.textSub, fontFamily: FONTS.mono }}>{k}: <b style={{ color: B.teal }}>{v}</b></span>
              ))}
            </div>
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
    // 1. Validações Iniciais
    if (!validateEmail(email)) { 
      setEmailErr("Formato de e-mail inválido"); 
      return; 
    }
    if (!farmName.trim() || coords.length < 3) { 
      setStatus({ loading: false, message: "Preencha todos os campos e desenhe o polígono.", type: "error" }); 
      return; 
    }

    setStatus({ loading: true, message: "A ligar ao servidor orbital...", type: "" });

    try {
      // 2. Chamada para a Cloud Function
      const res = await fetch(CLOUD_FUNCTION_URL, { 
        method: "POST", 
        headers: { "Content-Type": "application/json" }, 
        body: JSON.stringify({ 
          email, 
          nome_fazenda: farmName.trim(), 
          coordinates: coords, 
          data_ativacao: new Date().toISOString(), 
          project_id: "agroscan-ipe" 
        }) 
      });
      
      // 3. Verificação de Sucesso do Servidor
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Erro ${res.status}: Falha no processamento`);
      }

      // 4. Se chegou aqui, o e-mail deve ter sido disparado com sucesso
      const newFarm = {
        name: farmName.trim(), email, coords, ndvi: 0.71, nbr: 0.34, rvi: 0.42, vv: -11, rain7d: 22.4, rain30d: 85.1,
        lastCoord: coords[0] ? `${Math.abs(coords[0][1]).toFixed(4)}°S, ${Math.abs(coords[0][0]).toFixed(4)}°W` : "14.2350°S, 51.9253°W",
      };

      setStatus({ loading: false, message: "Monitorização ativada! Relatório em até 24h.", type: "success" });
      onRegister(newFarm);
      setTimeout(() => setView("home"), 2800);

    } catch (err) {
      // 5. EXIBIÇÃO DO ERRO REAL NO APK
      setStatus({ 
        loading: false, 
        message: `Falha: ${err.message}`, 
        type: "error" 
      });
      console.error("Erro no registro:", err);
    }
  };

  const statusColors = {
    success: { bg: B.greenGlow,  border: B.green, color: B.green, icon: "✓" },
    error:   { bg: "rgba(239,83,80,0.1)", border: B.red, color: B.red, icon: "⚠" },
    loading: { bg: B.tealGlow2,  border: B.teal,  color: B.teal, icon: "⏳" },
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
        { lbl: "NOME DA PROPRIEDADE *", ph: "Ex: Fazenda Santa Fé",    val: farmName, set: setFarmName, type: "text",  err: "" },
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
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
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
        {[{ show: page > 0, label: "←", onClick: () => setPage(p => p - 1) }, { show: page < GUIDE_PAGES.length - 1, label: "→", onClick: () => setPage(p => p + 1) }].map((btn, bi) => (
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
  const farm = farms[0];
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
        { label: "E-mail", value: farm?.email || "—" },
        { label: "Propriedade", value: farm?.name || "—" },
        { label: "Status", value: farm ? "Ativo" : "Sem cadastro", color: farm ? B.green : B.textMuted },
      ]} />
      <div style={S.sectionLabel}>SATÉLITES & FONTES</div>
      <InfoCard rows={[
        { label: "🛰 Sentinel-2", value: "Óptico · ESA Copernicus", color: B.green },
        { label: "📡 Sentinel-1", value: "Radar SAR · ESA", color: B.teal },
        { label: "🌧 CHIRPS", value: "Precipitação · NASA/UCSB", color: B.teal },
        { label: "☁️ Google EE", value: "Processamento em nuvem", color: B.textSub },
      ]} />
      <div style={S.sectionLabel}>INFRAESTRUTURA GCP</div>
      <InfoCard rows={[
        { label: "Cloud Function", value: "Python 3.10 · v2", mono: true },
        { label: "Scheduler Cron", value: "0 6 * * * (06h)", mono: true, color: B.teal },
        { label: "Banco de dados", value: "Firestore NoSQL", mono: true },
        { label: "Auth", value: "Firebase Auth", mono: true },
        { label: "Segredos", value: "GCP Secret Manager", mono: true },
      ]} />
      <div style={S.sectionLabel}>LICENÇAS</div>
      <div style={{ ...S.card, padding: 14 }}>
        <div style={{ fontSize: 11, color: B.textMuted, fontFamily: FONTS.exo, lineHeight: 1.7 }}>
          Dados Sentinel © Programa Copernicus (ESA). Bibliotecas sob Apache 2.0. AgroScan respeita os limites de quota da Google Earth Engine API.
        </div>
      </div>
      <div style={{ marginTop: 28, textAlign: "center", paddingBottom: 8 }}>
        <Logo size={30} />
        <div style={{ fontFamily: FONTS.mono, fontSize: 8, color: B.textMuted, letterSpacing: 2, marginTop: 8 }}>AGROSCAN v2.2 — APK BUILD · UFABC</div>
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
    // ✅ v2.2: safe-area-inset-bottom para respeitar barra de gesto do Android
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

  // ✅ Carrega dados do localStorage ao iniciar (sem tela de loading — síncrono)
  useEffect(() => {
    setFarms(loadFromStorage(STORAGE_KEYS.farms, []));
    setLogs(loadFromStorage(STORAGE_KEYS.logs, INITIAL_LOGS));
  }, []);

  useEffect(() => { saveToStorage(STORAGE_KEYS.farms, farms); }, [farms]);
  useEffect(() => { saveToStorage(STORAGE_KEYS.logs,  logs);  }, [logs]);

  const addLog = useCallback((text, type = "info") => {
    const time = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    setLogs(prev => [{ id: Date.now(), time, type, text }, ...prev].slice(0, 10));
  }, []);

  const handleRegister = useCallback(farm => {
    setFarms(prev => [farm, ...prev]);
    addLog(`Fazenda "${farm.name}" cadastrada — monitoramento iniciado`, "success");
    addLog(`Confirmação enviada para ${farm.email}`, "info");
    addLog("Processamento Sentinel-2 agendado para próxima janela orbital", "info");
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
        /* Desativa seleção de texto — UX nativo */
        *{-webkit-user-select:none;user-select:none}
        input,textarea{-webkit-user-select:text;user-select:text}
      `}</style>

      {/* ✅ v2.2: sem Phone Frame — div ocupa 100% da viewport nativa */}
      <div style={{
        position: "relative", width: "100vw", height: "100vh",
        background: B.bg0, overflow: "hidden",
        backgroundImage: `
          radial-gradient(ellipse at 20% 15%, rgba(0,100,180,0.08) 0%, transparent 55%),
          radial-gradient(ellipse at 80% 85%, rgba(0,150,200,0.06) 0%, transparent 55%)`,
      }}>
        <div style={{ position: "absolute", inset: 0 }}>
          {view === "home"         && <HomeView setView={setView} farms={farms} logs={logs} />}
          {view === "registration" && <RegistrationView setView={setView} onRegister={handleRegister} />}
          {view === "guide"        && <GuideView setView={setView} />}
          {view === "settings"     && <SettingsView farms={farms} />}
        </div>
        <BottomNav view={view} setView={setView} />
      </div>
    </>
  );
}