import functions_framework
import ee
import json
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, timedelta
import os
import logging
from typing import Dict, List, Optional
import uuid
from google.cloud import firestore
from google.api_core.exceptions import GoogleAPICallError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

PROJECT_ID   = 'agroscan-ipe'
EMAIL_SENDER = 'agroscanipe@gmail.com'

try:
    ee.Initialize(project=PROJECT_ID)
except Exception as e:
    logger.error(f"Erro Earth Engine: {e}")
    raise

try:
    db = firestore.Client(project=PROJECT_ID)
except Exception as e:
    logger.error(f"Erro Firestore: {e}")
    raise

# ─── CORS ─────────────────────────────────────────────────────────────────────
CORS_HEADERS = {'Access-Control-Allow-Origin': '*'}

def handle_preflight(request):
    if request.method == 'OPTIONS':
        return ('', 204, {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age':       '3600',
        })
    return None


# ─── FIRESTORE ────────────────────────────────────────────────────────────────
class FirestoreManager:
    @staticmethod
    def save_farm(email: str, farm_name: str, coordinates: List) -> str:
        farm_id  = str(uuid.uuid4())
        farm_data = {
            'email':          email,
            'nome_fazenda':   farm_name,
            'coordinates':    json.dumps(coordinates),
            'data_ativacao':  datetime.now(),
            'status':         'active',
            'ultima_analise': None,
            'total_analises': 0,
        }
        db.collection('fazendas').document(farm_id).set(farm_data)
        return farm_id

    @staticmethod
    def get_active_farms() -> List[Dict]:
        farms_ref    = db.collection('fazendas').where('status', '==', 'active')
        active_farms = []
        for doc in farms_ref.stream():
            data = doc.to_dict()
            data['farm_id'] = doc.id
            if 'coordinates' in data and isinstance(data['coordinates'], str):
                data['coordinates'] = json.loads(data['coordinates'])
            active_farms.append(data)
        return active_farms

    @staticmethod
    def save_analysis_result(farm_id: str, analysis_data: Dict, prescriptions: List[str]) -> bool:
        db.collection('fazendas').document(farm_id).collection('historico').add({
            'data_analise':       datetime.now(),
            'dados_earth_engine': analysis_data,
            'prescricoes':        prescriptions,
            'email_enviado':      True,
        })
        return True


# ─── EARTH ENGINE DATA PROCESSOR ──────────────────────────────────────────────
class AgroDataProcessor:
    def __init__(self, geometry: ee.Geometry):
        self.geometry   = geometry
        self.end_date   = datetime.now()
        self.start_date = self.end_date - timedelta(days=30)

    def _reduce(self, image: ee.Image, scale: int = 10) -> Dict:
        """
        bestEffort=True  → nunca aborta por excesso de pixels
        tileScale=4      → divide em tiles, evita OOM
        maxPixels=1e13   → suporta polígonos até ~100 000 ha
        """
        return image.reduceRegion(
            reducer=ee.Reducer.mean(),
            geometry=self.geometry,
            scale=scale,
            maxPixels=1e13,
            bestEffort=True,
            tileScale=4,
        ).getInfo()

    def get_precipitation_data(self) -> Dict:
        """
        Fusão de 4 Camadas — janelas temporais sem sobreposição
        ────────────────────────────────────────────────────────
        Segmento A  CHIRPS (5 km)        t-30 → t-5   histórico base
        Segmento B  ERA5-Land (9 km)     t-5  → t-2   gap do CHIRPS
                    PERSIANN (4 km)      t-5  → t-2   fallback se ERA5 vazio
        Segmento C  GPM IMERG V07 (10km) t-2  → agora quasi-real-time

        7d  = CHIRPS(t-7→t-5)  + seg_B + seg_C
        30d = CHIRPS(t-30→t-5) + seg_B + seg_C

        seg_B e seg_C são calculados UMA vez e reutilizados nas duas janelas.
        Não há sobreposição entre segmentos.
        """
        try:
            now = self.end_date
            t30 = now - timedelta(days=30)
            t7  = now - timedelta(days=7)
            t5  = now - timedelta(days=5)
            t2  = now - timedelta(days=2)

            sources_used = []

            # ── Segmento A: CHIRPS ────────────────────────────────────────────
            chirps = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY').select('precipitation')

            n_ch30 = chirps.filterDate(t30, t5).size().getInfo()
            n_ch7  = chirps.filterDate(t7,  t5).size().getInfo()
            logger.info(f"CHIRPS — 30d: {n_ch30} imgs  7d: {n_ch7} imgs")

            seg_a_30 = chirps.filterDate(t30, t5).sum().unmask(0) if n_ch30 > 0 else ee.Image.constant(0).rename('precipitation')
            seg_a_7  = chirps.filterDate(t7,  t5).sum().unmask(0) if n_ch7  > 0 else ee.Image.constant(0).rename('precipitation')

            if n_ch30 > 0:
                sources_used.append(f'CHIRPS ({n_ch30} imgs)')

            # ── Segmento B: ERA5-Land ou PERSIANN (t-5 → t-2) ────────────────
            era5_col = (ee.ImageCollection('ECMWF/ERA5_LAND/DAILY_AGGR')
                        .filterDate(t5, t2)
                        .select('total_precipitation_sum'))
            n_era5 = era5_col.size().getInfo()
            logger.info(f"ERA5-Land (t-5→t-2): {n_era5} imgs")

            if n_era5 > 0:
                seg_b = era5_col.map(
                    lambda img: img.multiply(1000).rename('precipitation')
                ).sum().unmask(0)
                sources_used.append(f'ERA5-Land ({n_era5} imgs)')
            else:
                logger.warning("ERA5 vazio — tentando PERSIANN-CCS-CDR.")
                persiann_col = (ee.ImageCollection('NOAA/PERSIANN-CDR')
                                .filterDate(t5, t2)
                                .select('precipitation'))
                n_persiann = persiann_col.size().getInfo()
                logger.info(f"PERSIANN-CCS (t-5→t-2): {n_persiann} imgs")

                if n_persiann > 0:
                    seg_b = persiann_col.sum().unmask(0)
                    sources_used.append(f'PERSIANN-CCS ({n_persiann} imgs, ERA5 fallback)')
                else:
                    logger.warning("PERSIANN também vazio — segmento B zerado.")
                    seg_b = ee.Image.constant(0).rename('precipitation')
                    sources_used.append('seg_B=zero (ERA5+PERSIANN indisponíveis)')

            # ── Segmento C: GPM IMERG — fallback em cascata ───────────────────
            # V07 Early Run: latência ~6h | V06 Final Run: fallback histórico
            GPM_COLLECTIONS = [
                ('NASA/GPM_L3/IMERG_V07/HHC', 'precipitation',    0.5),
                ('NASA/GPM_L3/IMERG_V06',      'precipitationCal', 0.5),
            ]

            seg_c = ee.Image.constant(0).rename('precipitation')
            for col_id, band, factor in GPM_COLLECTIONS:
                try:
                    gpm_col = (ee.ImageCollection(col_id)
                               .filterDate(t2, now)
                               .select(band))
                    n_gpm = gpm_col.size().getInfo()
                    logger.info(f"GPM {col_id} (t-2→agora): {n_gpm} imgs")
                    if n_gpm > 0:
                        seg_c = gpm_col.map(
                            lambda img: img.multiply(factor).rename('precipitation')
                        ).sum().unmask(0)
                        sources_used.append(f'GPM {col_id} ({n_gpm} imgs)')
                        break
                except Exception as gpm_err:
                    logger.warning(f"GPM {col_id} falhou: {gpm_err}")

            if not any('GPM' in s for s in sources_used):
                logger.warning("Todos os GPM falharam — segmento C zerado.")
                sources_used.append('seg_C=zero (GPM indisponível)')

            # ── Fusão aditiva (sem sobreposição garantida) ────────────────────
            hybrid_30 = seg_a_30.add(seg_b).add(seg_c)
            hybrid_7  = seg_a_7.add(seg_b).add(seg_c)

            logger.info("Cobertura temporal verificada:")
            logger.info(f"  30d = CHIRPS({t30.date()}→{t5.date()}) + B({t5.date()}→{t2.date()}) + C({t2.date()}→{now.date()})")
            logger.info(f"   7d = CHIRPS({t7.date()}→{t5.date()}) + B({t5.date()}→{t2.date()}) + C({t2.date()}→{now.date()})")

            # ── Redução espacial com escala adaptativa ────────────────────────
            def reduce_with_fallback(image, label):
                for scale in [5000, 10000, 25000, 50000]:
                    try:
                        result = image.reduceRegion(
                            reducer=ee.Reducer.mean(),
                            geometry=self.geometry,
                            scale=scale,
                            maxPixels=1e13,
                            bestEffort=True,
                            tileScale=4,
                        ).getInfo()
                        val = result.get('precipitation')
                        if val is not None:
                            logger.info(f"{label}: {round(val, 1)} mm (escala {scale}m)")
                            return float(val)
                        logger.warning(f"{label}: null em escala {scale}m, tentando maior.")
                    except Exception as e:
                        logger.warning(f"{label}: erro em escala {scale}m — {e}")
                logger.error(f"{label}: SAFETY NET — todas as escalas falharam.")
                return None

            p7  = reduce_with_fallback(hybrid_7,  "7d")
            p30 = reduce_with_fallback(hybrid_30, "30d")

            data_gap = (p7 is None or p30 is None)
            p7  = p7  if p7  is not None else 0.0
            p30 = p30 if p30 is not None else 0.0

            logger.info(f"Resultado precipitação — 7d: {p7} mm | 30d: {p30} mm | sources: {sources_used}")

            return {
                'precipitation_sum_7d':  round(p7,  1),
                'precipitation_sum_30d': round(p30, 1),
                'data_gap': data_gap,
                'sources':  sources_used,
                'status':   'success',
            }

        except Exception as e:
            logger.error(f"Erro Fusão de Precipitação: {e}", exc_info=True)
            return {
                'precipitation_sum_7d':  0.0,
                'precipitation_sum_30d': 0.0,
                'data_gap': True,
                'sources':  ['exception'],
                'status':   'error',
            }

    def get_radar_data(self) -> Dict:
        try:
            s1 = (ee.ImageCollection('COPERNICUS/S1_GRD')
                  .filterDate(self.start_date, self.end_date)
                  .filter(ee.Filter.eq('instrumentMode', 'IW'))
                  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
                  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
                  .select(['VV', 'VH']))

            s1_count = s1.size().getInfo()
            logger.info(f"Sentinel-1 imagens: {s1_count}")
            if s1_count == 0:
                logger.warning("Sentinel-1: nenhuma imagem no período (gap orbital).")
                return {'vv_mean': None, 'rvi_mean': None, 'rvi_series': [], 'status': 'no_data'}

            def calc_rvi(img):
                rvi = img.select('VH').multiply(4).divide(
                    img.select('VV').add(img.select('VH'))
                ).rename('RVI')
                return img.addBands(rvi)

            s1_rvi = s1.map(calc_rvi)

            def extract_rvi(img):
                val = img.select('RVI').reduceRegion(
                    reducer=ee.Reducer.mean(), geometry=self.geometry,
                    scale=10, maxPixels=1e13, bestEffort=True, tileScale=4,
                ).get('RVI')
                return img.set('rvi_val', ee.Algorithms.If(
                    ee.Algorithms.IsEqual(val, None), -9999, val
                ))

            series_raw   = s1_rvi.map(extract_rvi).aggregate_array('rvi_val').getInfo() or []
            clean_series = [v for v in series_raw if v is not None and v != -9999]
            logger.info(f"RVI série: {len(clean_series)} pontos válidos")

            stats = self._reduce(s1_rvi.mean(), scale=10)
            logger.info(f"Radar stats: {stats}")

            return {
                'vv_mean':    stats.get('VV'),
                'rvi_mean':   stats.get('RVI'),
                'rvi_series': clean_series,
                'status':     'success',
            }
        except Exception as e:
            logger.error(f"Erro Sentinel-1: {e}", exc_info=True)
            return {'vv_mean': None, 'rvi_mean': None, 'rvi_series': [], 'status': 'error'}

    def get_optical_data(self) -> Dict:
        try:
            def build_s2(cloud_pct):
                return (ee.ImageCollection('COPERNICUS/S2_HARMONIZED')
                        .filterDate(self.start_date, self.end_date)
                        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', cloud_pct)))

            s2 = build_s2(30)
            s2_count = s2.size().getInfo()
            logger.info(f"Sentinel-2 (cloud<30%): {s2_count} imagens")

            if s2_count < 3:
                logger.warning(f"Apenas {s2_count} cenas limpas. Relaxando para cloud<60%.")
                s2       = build_s2(60)
                s2_count = s2.size().getInfo()
                logger.info(f"Sentinel-2 (cloud<60%): {s2_count} imagens")

            if s2_count == 0:
                logger.warning("Sentinel-2: nenhuma imagem disponível.")
                return {'ndvi_mean': None, 'nbr_mean': None, 'ndvi_series': [], 'status': 'no_data'}

            def add_indices(img):
                return img.addBands([
                    img.normalizedDifference(['B8', 'B4']).rename('NDVI'),
                    img.normalizedDifference(['B8', 'B12']).rename('NBR'),
                ])

            s2_idx = s2.map(add_indices)

            def extract_ndvi(img):
                val = img.select('NDVI').reduceRegion(
                    reducer=ee.Reducer.mean(), geometry=self.geometry,
                    scale=10, maxPixels=1e13, bestEffort=True, tileScale=4,
                ).get('NDVI')
                return img.set('ndvi_val', ee.Algorithms.If(
                    ee.Algorithms.IsEqual(val, None), -9999, val
                ))

            series_raw   = s2_idx.map(extract_ndvi).aggregate_array('ndvi_val').getInfo() or []
            clean_series = [v for v in series_raw if v is not None and v != -9999]
            logger.info(f"NDVI série: {len(clean_series)} pontos")

            stats = self._reduce(s2_idx.mean(), scale=10)
            logger.info(f"Optical stats: {stats}")

            return {
                'ndvi_mean':   stats.get('NDVI'),
                'nbr_mean':    stats.get('NBR'),
                'ndvi_series': clean_series,
                'status':      'success',
            }
        except Exception as e:
            logger.error(f"Erro Sentinel-2: {e}", exc_info=True)
            return {'ndvi_mean': None, 'nbr_mean': None, 'ndvi_series': [], 'status': 'error'}


# ─── Z-SCORE ──────────────────────────────────────────────────────────────────
def calc_zscore_python(series: List[float]) -> Optional[float]:
    if not series or len(series) < 2:
        return None
    mean     = sum(series) / len(series)
    variance = sum((v - mean) ** 2 for v in series) / len(series)
    std      = variance ** 0.5
    if std == 0:
        return 0.0
    return (series[-1] - mean) / std


# ─── PRESCRIPTION ENGINE ──────────────────────────────────────────────────────
class PrescriptionEngine:
    @staticmethod
    def generate_prescription(data: Dict) -> List[str]:
        p      = []
        nbr    = data.get('nbr_mean')
        ndvi   = data.get('ndvi_mean')
        rain7d = float(data.get('precipitation_sum_7d') or 0)

        rvi_series = data.get('rvi_series') or []
        rvi_z      = calc_zscore_python(rvi_series)

        # Só avalia se o dado realmente existe (evita falso-alerta quando None)
        if nbr is not None and float(nbr) < 0.1:
            p.append("VULNERABILIDADE CRÍTICA: Resposta espectral indica dessecação severa da vegetação. Alto risco de ignição ou degradação do solo.")
        if ndvi is not None and float(ndvi) < 0.4 and rain7d > 20:
            p.append("ALERTA NUTRICIONAL: Baixo vigor vegetativo com solo úmido — possível deficiência nutricional ou ataque de pragas.")
        if rvi_z is not None and rvi_z < -1.5:
            p.append(f"ANOMALIA RADAR (Z={rvi_z:.2f}): O índice RVI está {abs(rvi_z):.1f} desvios-padrão abaixo da média dos últimos 30 dias desta fazenda. Avalie irrigação ou drenagem.")

        missing = [k for k, v in [('NDVI', ndvi), ('NBR', nbr), ('RVI', data.get('rvi_mean'))] if v is None]
        if missing:
            p.append(f"⚠️ DADOS PARCIAIS: {', '.join(missing)} indisponíveis nesta janela orbital.")

        if not p:
            p.append("Monitoramento Normal — Sem ações urgentes requeridas.")
        return p


# ─── EMAIL ────────────────────────────────────────────────────────────────────
class EmailNotifier:
    def send_report(self, recipient_email: str, farm_name: str, data: Dict, prescriptions: List[str]) -> bool:
        try:
            msg            = MIMEMultipart()
            msg['From']    = EMAIL_SENDER
            msg['To']      = recipient_email
            msg['Subject'] = f"🌾 AgroScan - Relatório Diário: {farm_name}"

            p7   = float(data.get('precipitation_sum_7d')  or 0)
            p30  = float(data.get('precipitation_sum_30d') or 0)
            ndvi = float(data.get('ndvi_mean') or 0)
            nbr  = float(data.get('nbr_mean')  or 0)
            rvi  = float(data.get('rvi_mean')  or 0)

            rvi_series = data.get('rvi_series') or []
            rvi_z      = calc_zscore_python(rvi_series)
            rvi_z_str  = f"{rvi_z:.2f}" if rvi_z is not None else "N/D"

            data_hoje   = datetime.now().strftime('%d/%m/%Y')
            alert_color = (
                "red"    if any("VULNERABILIDADE" in p for p in prescriptions) else
                "orange" if any("ALERTA" in p or "ANOMALIA" in p for p in prescriptions) else
                "green"
            )

            html_body = f"""
            <html><body style="font-family:Arial,sans-serif;margin:0;padding:20px;background:#f5f5f5;">
            <div style="max-width:600px;margin:0 auto;background:white;padding:30px;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,0.1);">
              <div style="text-align:center;border-bottom:3px solid #2E8B57;padding-bottom:20px;margin-bottom:30px;">
                <h1 style="color:#2E8B57;margin:0;">🌾 AgroScan</h1>
                <h2 style="color:#333;margin:10px 0;">Relatório de Monitoramento Agrícola</h2>
                <p style="color:#666;margin:5px 0;"><strong>Fazenda:</strong> {farm_name}</p>
                <p style="color:#666;margin:5px 0;"><strong>Data:</strong> {data_hoje}</p>
              </div>
              <div style="background:#e8f5e8;padding:20px;border-radius:8px;margin-bottom:20px;">
                <h3 style="color:#2E8B57;margin-top:0;">🌧️ Precipitação (CHIRPS + ERA5 + GPM)</h3>
                <p style="margin:5px 0;"><strong>Últimos 7 dias:</strong> {p7:.1f} mm</p>
                <p style="margin:5px 0;"><strong>Últimos 30 dias:</strong> {p30:.1f} mm</p>
              </div>
              <div style="background:#e8f0ff;padding:20px;border-radius:8px;margin-bottom:20px;">
                <h3 style="color:#1e40af;margin-top:0;">🌱 Índices de Vegetação</h3>
                <p style="margin:5px 0;"><strong>NDVI (Vigor): {ndvi:.3f}</strong><br>
                <span style="font-size:.9em;color:#555;">Saúde e fotossíntese da vegetação (Sentinel-2).</span></p>
                <p style="margin:15px 0 5px 0;"><strong>NBR (Risco de Degradação): {nbr:.3f}</strong><br>
                <span style="font-size:.9em;color:#555;">Umidade da vegetação e risco de incêndio.</span></p>
                <p style="margin:15px 0 5px 0;"><strong>RVI (Radar): {rvi:.3f} — Z-Score: {rvi_z_str}</strong><br>
                <span style="font-size:.9em;color:#555;">Densidade e estrutura via SAR Sentinel-1. Z-Score indica desvio em relação à média histórica da fazenda.</span></p>
              </div>
              <div style="background:#fff3cd;padding:20px;border-radius:8px;margin-bottom:20px;border-left:5px solid {alert_color};">
                <h3 style="color:#856404;margin-top:0;">📋 Prescrições e Recomendações</h3>
            """
            for pr in prescriptions:
                html_body += f"<p style='margin:10px 0;padding:10px;background:white;border-radius:5px;'>{pr}</p>"

            html_body += """
              </div>
              <div style="text-align:center;margin-top:30px;padding-top:20px;border-top:1px solid #ddd;color:#666;">
                <p><em>Relatório gerado automaticamente pelo AgroScan</em></p>
                <p><small>Projeto de Inovações para Engenharia | Google Earth Engine API</small></p>
              </div>
            </div></body></html>
            """
            msg.attach(MIMEText(html_body, 'html'))
            with smtplib.SMTP("smtp.gmail.com", 587) as server:
                server.starttls()
                server.login(EMAIL_SENDER, os.environ.get('GMAIL_APP_PASSWORD'))
                server.send_message(msg)
            return True
        except Exception as e:
            logger.error(f"Erro e-mail: {e}")
            return False


# ─── FCM PUSH ─────────────────────────────────────────────────────────────────
def send_push_notification(fcm_token: str, farm_name: str, prescriptions: List[str]) -> bool:
    try:
        import firebase_admin
        from firebase_admin import messaging as fcm_messaging
        if not firebase_admin._apps:
            firebase_admin.initialize_app()  # credenciais GCP automáticas

        has_critical = any("VULNERABILIDADE" in p for p in prescriptions)
        has_alert    = any("ALERTA" in p or "ANOMALIA" in p for p in prescriptions)
        title = (
            f"🔴 Alerta Crítico — {farm_name}" if has_critical else
            f"🟠 Atenção — {farm_name}"        if has_alert    else
            f"✅ Análise concluída — {farm_name}"
        )
        body = prescriptions[0][:200] if prescriptions else "Análise orbital concluída."

        fcm_messaging.send(fcm_messaging.Message(
            notification = fcm_messaging.Notification(title=title, body=body),
            token        = fcm_token,
            android      = fcm_messaging.AndroidConfig(priority='high'),
            apns         = fcm_messaging.APNSConfig(
                payload  = fcm_messaging.APNSPayload(aps=fcm_messaging.Aps(sound='default'))
            ),
        ))
        logger.info(f"Push enviado — token ...{fcm_token[-8:]}")
        return True
    except Exception as e:
        logger.warning(f"Push falhou (não crítico): {e}")
        return False


# ─── PROCESS FARM ─────────────────────────────────────────────────────────────
def process_single_farm(farm_data: Dict) -> Dict:
    logger.info(f"Iniciando análise: {farm_data.get('nome_fazenda')}")

    proc = AgroDataProcessor(ee.Geometry.Polygon([farm_data['coordinates']]))
    pd   = proc.get_precipitation_data()
    rd   = proc.get_radar_data()
    od   = proc.get_optical_data()

    # Loga falhas mas NÃO interrompe — graceful degradation
    for name, result in [('precipitação', pd), ('radar', rd), ('óptico', od)]:
        if result.get('status') == 'error':
            logger.warning(f"Módulo {name} falhou — continuando com dados parciais.")

    cd = {
        'precipitation_sum_7d':  pd.get('precipitation_sum_7d'),
        'precipitation_sum_30d': pd.get('precipitation_sum_30d'),
        'data_gap':              pd.get('data_gap', False),
        'precip_sources':        pd.get('sources', []),
        'ndvi_mean':             od.get('ndvi_mean'),
        'nbr_mean':              od.get('nbr_mean'),
        'ndvi_series':           od.get('ndvi_series', []),
        'rvi_mean':              rd.get('rvi_mean'),
        'vv_mean':               rd.get('vv_mean'),
        'rvi_series':            rd.get('rvi_series', []),
    }

    failed  = [k for k, v in cd.items() if v is None]
    success = [k for k, v in cd.items() if v is not None]
    if failed:
        logger.warning(f"Índices com falha: {failed}")
    logger.info(f"Índices obtidos: {success}")

    pr       = PrescriptionEngine.generate_prescription(cd)
    email_ok = EmailNotifier().send_report(farm_data['email'], farm_data['nome_fazenda'], cd, pr)
    if not email_ok:
        pr.append("⚠️ Análise salva, mas e-mail não foi entregue.")

    FirestoreManager.save_analysis_result(farm_data['farm_id'], cd, pr)

    fcm_token = farm_data.get('fcm_token')
    if fcm_token:
        send_push_notification(fcm_token, farm_data['nome_fazenda'], pr)

    return {
        'status':        'success' if email_ok else 'email_error',
        'data':          cd,
        'prescriptions': pr,
        'diagnostics':   {'failed': failed, 'success': success},
    }


# ─── HTTP ENTRY POINTS ────────────────────────────────────────────────────────
@functions_framework.http
def agroscan_monitor(request):
    preflight = handle_preflight(request)
    if preflight:
        return preflight

    try:
        req       = request.get_json()
        fcm_token = req.get('fcm_token')  # pode ser None se usuário negou permissão
        fid       = FirestoreManager.save_farm(req['email'], req['nome_fazenda'], req['coordinates'])
        result    = process_single_farm({
            'farm_id':      fid,
            'email':        req['email'],
            'nome_fazenda': req['nome_fazenda'],
            'coordinates':  req['coordinates'],
            'fcm_token':    fcm_token,
        })
        return json.dumps(result), 200, CORS_HEADERS
    except Exception as e:
        logger.error(f"Erro agroscan_monitor: {e}")
        return json.dumps({'error': str(e)}), 500, CORS_HEADERS


@functions_framework.http
def daily_monitoring(request):
    preflight = handle_preflight(request)
    if preflight:
        return preflight

    try:
        farms   = FirestoreManager.get_active_farms()
        results = [process_single_farm(f) for f in farms]
        return json.dumps({'status': 'success', 'processed': len(farms), 'results': results}), 200, CORS_HEADERS
    except Exception as e:
        logger.error(f"Erro daily_monitoring: {e}")
        return json.dumps({'error': str(e)}), 500, CORS_HEADERS