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
        existing = (db.collection('fazendas')
                      .where('email',        '==', email)
                      .where('nome_fazenda', '==', farm_name)
                      .where('status',       '==', 'active')
                      .limit(1).stream())
        docs = list(existing)
        if docs:
            farm_id = docs[0].id
            logger.info(f"Fazenda ja existe — reutilizando farm_id {farm_id}")
            return farm_id

        farm_id   = str(uuid.uuid4())
        farm_data = {
            'email': email, 'nome_fazenda': farm_name,
            'coordinates': json.dumps(coordinates),
            'data_ativacao': datetime.now(), 'status': 'active',
            'ultima_analise': None, 'total_analises': 0,
        }
        db.collection('fazendas').document(farm_id).set(farm_data)
        logger.info(f"Nova fazenda criada — farm_id {farm_id}")
        return farm_id

    @staticmethod
    def get_active_farms() -> List[Dict]:
        farms_ref = db.collection('fazendas').where('status', '==', 'active')
        result = []
        for doc in farms_ref.stream():
            data = doc.to_dict()
            data['farm_id'] = doc.id
            if 'coordinates' in data and isinstance(data['coordinates'], str):
                data['coordinates'] = json.loads(data['coordinates'])
            result.append(data)
        return result

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
        return image.reduceRegion(
            reducer=ee.Reducer.mean(),
            geometry=self.geometry,
            scale=scale,
            maxPixels=1e13,
            bestEffort=True,
            tileScale=4,
        ).getInfo()

    def _reduce_precip(self, image: ee.Image, label: str, geom=None) -> Optional[float]:
        for scale in [5000, 10000, 25000, 50000]:
            try:
                val = image.reduceRegion(
                    reducer=ee.Reducer.mean(), geometry=geom if geom else self.geometry,
                    scale=scale, maxPixels=1e13, bestEffort=True, tileScale=4,
                ).getInfo().get('precipitation')
                if val is not None:
                    logger.info(f"  {label}: {round(val, 2)} mm (escala {scale}m)")
                    return float(val)
            except Exception as e:
                logger.warning(f"  {label}: erro escala {scale}m — {e}")
        logger.error(f"  {label}: null em todas as escalas")
        return None

    # ── PRECIPITACAO ──────────────────────────────────────────────────────────
    def get_precipitation_data(self) -> Dict:
        """
        Fusao temporal em 3 segmentos — TODOS com filterBounds(self.geometry).
        data_gap=True apenas quando TODOS os segmentos retornam None.
        0.0 mm e chuva zero valida, nao confundir com gap.
        """
        try:
            now = self.end_date
            t30 = now - timedelta(days=30)
            t7  = now - timedelta(days=7)
            t5  = now - timedelta(days=5)
            t2  = now - timedelta(days=2)

            zero         = ee.Image.constant(0).rename('precipitation')
            sources_used = []

            logger.info("=== DIAGNOSTICO PRECIPITACAO ===")

            # Segmento A: CHIRPS
            logger.warning('=== INICIANDO PRECIPITACAO ===')
            # Buffer de 5km para garantir intersecao com pixels GPM/CHIRPS (~10km)
            geom_precip = self.geometry.buffer(5000)
            chirps = (ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY')
                      .filterBounds(self.geometry)
                      .select('precipitation'))

            n_ch30 = chirps.filterDate(t30, t5).size().getInfo()
            n_ch7  = chirps.filterDate(t7,  t5).size().getInfo()
            logger.warning(f"CHIRPS: {n_ch30} imgs (30d) / {n_ch7} imgs (7d)")

            seg_a_30 = chirps.filterDate(t30, t5).sum().unmask(0) if n_ch30 > 0 else zero
            seg_a_7  = chirps.filterDate(t7,  t5).sum().unmask(0) if n_ch7  > 0 else zero
            if n_ch30 > 0:
                sources_used.append(f'CHIRPS({n_ch30})')

            v_ch30 = self._reduce_precip(seg_a_30, 'CHIRPS-30d', geom=geom_precip)
            v_ch7  = self._reduce_precip(seg_a_7, 'CHIRPS-7d', geom=geom_precip)

            # Segmento B: ERA5-Land ou PERSIANN
            era5_col = (ee.ImageCollection('ECMWF/ERA5_LAND/DAILY_AGGR')
                        .filterBounds(geom_precip)
                        .filterDate(t5, t2)
                        .select('total_precipitation_sum'))
            n_era5 = era5_col.size().getInfo()
            logger.warning(f"ERA5-Land: {n_era5} imgs")

            if n_era5 > 0:
                seg_b = era5_col.map(
                    lambda img: img.multiply(1000).rename('precipitation')
                ).sum().unmask(0)
                sources_used.append(f'ERA5({n_era5})')
            else:
                # Tenta ERA5 classico antes do PERSIANN
                era5c = (ee.ImageCollection("ECMWF/ERA5/DAILY")
                         .filterBounds(geom_precip)
                         .filterDate(t5, t2)
                         .select("total_precipitation"))
                n_era5c = era5c.size().getInfo()
                logger.warning(f"ERA5-classic: {n_era5c} imgs")
                if n_era5c > 0:
                    seg_b = era5c.map(
                        lambda img: img.multiply(1000).rename("precipitation")
                    ).sum().unmask(0)
                    sources_used.append(f"ERA5c({n_era5c})")
                    n_era5 = n_era5c  # pula o bloco PERSIANN
                logger.warning("ERA5 vazio — tentando PERSIANN-CDR")
                persiann_col = (ee.ImageCollection('NOAA/PERSIANN-CDR')
                                .filterBounds(self.geometry)
                                .filterDate(t5, t2)
                                .select('precipitation'))
                n_p = persiann_col.size().getInfo()
                logger.info(f"PERSIANN: {n_p} imgs (t-5->t-2)")
                if n_p > 0:
                    seg_b = persiann_col.sum().unmask(0)
                    sources_used.append(f'PERSIANN({n_p})')
                else:
                    logger.warning("PERSIANN vazio — segmento B = zero")
                    seg_b = zero

            v_b = self._reduce_precip(seg_b, 'seg_B(ERA5/PERSIANN)', geom=geom_precip)

            # Segmento C: GPM IMERG em cascata
            GPM_COLLECTIONS = [
                ('NASA/GPM_L3/IMERG_V07', 'precipitation',    0.5),
                ('NASA/GPM_L3/IMERG_V06', 'precipitationCal', 0.5),
                ('NASA/GPM_L3/IMERG_V06B', 'precipitationCal', 0.5),
            ]
            seg_c = zero
            seg_c_30 = zero
            seg_c_7  = zero
            for col_id, band, factor in GPM_COLLECTIONS:
                try:
                    col = (ee.ImageCollection(col_id)
                           .filterBounds(geom_precip)
                           .select(band))
                    col30 = col.filterDate(t30, now)
                    col7  = col.filterDate(t7,  now)
                    n_gpm = col30.size().getInfo()
                    logger.warning(f"GPM {col_id}: {n_gpm} imgs (30d)")
                    if n_gpm > 0:
                        seg_c_30 = col30.map(lambda img: img.multiply(factor).rename('precipitation')).sum().unmask(0)
                        seg_c_7  = col7.map( lambda img: img.multiply(factor).rename('precipitation')).sum().unmask(0)
                        sources_used.append(f'GPM-{col_id.split("/")[-1]}({n_gpm})')
                        break
                except Exception as e:
                    logger.warning(f"GPM {col_id} erro: {e}")

            v_c = self._reduce_precip(seg_c_30, 'seg_C(GPM)', geom=geom_precip)

            # Fusao
            hybrid_30 = seg_a_30.add(seg_b).add(seg_c_30)
            hybrid_7  = seg_a_7.add(seg_b).add(seg_c_7)

            p30 = self._reduce_precip(hybrid_30, 'TOTAL-30d', geom=geom_precip)
            p7  = self._reduce_precip(hybrid_7, 'TOTAL-7d', geom=geom_precip)

            # data_gap = True apenas quando TODOS os segmentos falharam
            all_missing = (v_ch30 is None) and (v_b is None) and (v_c is None)
            data_gap    = all_missing or (p7 is None and p30 is None)

            p7_out  = round(p7,  1) if p7  is not None else None
            p30_out = round(p30, 1) if p30 is not None else None

            logger.info(f"=== RESULTADO: 7d={p7_out}mm 30d={p30_out}mm gap={data_gap} ===")
            logger.info(f"    Parciais: CHIRPS-7d={v_ch7} CHIRPS-30d={v_ch30} B={v_b} C={v_c}")

            return {
                'precipitation_sum_7d':  p7_out,
                'precipitation_sum_30d': p30_out,
                'data_gap': data_gap,
                'sources':  sources_used,
                'status':   'success',
            }

        except Exception as e:
            logger.error(f"Erro precipitacao: {e}", exc_info=True)
            return {
                'precipitation_sum_7d':  None,
                'precipitation_sum_30d': None,
                'data_gap': True,
                'sources':  ['exception'],
                'status':   'error',
            }

    # ── RADAR ─────────────────────────────────────────────────────────────────
    def get_radar_data(self) -> Dict:
        try:
            s1 = (ee.ImageCollection('COPERNICUS/S1_GRD')
                  .filterBounds(self.geometry)
                  .filterDate(self.start_date, self.end_date)
                  .filter(ee.Filter.eq('instrumentMode', 'IW'))
                  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
                  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
                  .select(['VV', 'VH']))

            s1_count = s1.size().getInfo()
            logger.info(f"Sentinel-1 imagens: {s1_count}")
            if s1_count == 0:
                logger.warning("Sentinel-1: nenhuma imagem no periodo.")
                return {'vv_mean': None, 'rvi_mean': None, 'rvi_series': [], 'status': 'no_data'}

            def calc_rvi(img):
                return img.addBands(
                    img.select('VH').multiply(4).divide(
                        img.select('VV').add(img.select('VH'))
                    ).rename('RVI')
                )

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
            logger.info(f"RVI serie: {len(clean_series)} pontos validos")

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

    # ── OPTICO: S2 -> Landsat 8/9 -> MODIS ───────────────────────────────────
    def get_optical_data(self) -> Dict:
        """
        Cadeia de fallback para NDVI e NBR:
          1. Sentinel-2 Harmonized  cloud<30%  janela 30d
          2. Sentinel-2 Harmonized  cloud<80%  janela 60d
          3. Landsat 8/9 C2 L2      cloud<30%  janela 30d
          4. Landsat 8/9 C2 L2      cloud<60%  janela 60d
          5. MODIS MOD13Q1 250m      NDVI only  janela 48d
        Todas as colecoes com filterBounds.
        """
        try:
            # Tentativas 1 & 2: Sentinel-2
            for cloud_pct, days, label in [
                (30, 30, "Sentinel-2 (cloud<30%)"),
                (80, 60, "Sentinel-2 (cloud<80% 60d)"),
            ]:
                start = self.end_date - timedelta(days=days)
                s2 = (ee.ImageCollection('COPERNICUS/S2_HARMONIZED')
                      .filterBounds(self.geometry)
                      .filterDate(start, self.end_date)
                      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', cloud_pct)))

                n = s2.size().getInfo()
                logger.info(f"{label}: {n} imagens")

                if n >= 1:
                    def add_s2_indices(img):
                        return img.addBands([
                            img.normalizedDifference(['B8', 'B4']).rename('NDVI'),
                            img.normalizedDifference(['B8', 'B12']).rename('NBR'),
                        ])
                    s2_idx = s2.map(add_s2_indices)
                    series = self._extract_series(s2_idx, 'NDVI')
                    stats  = self._reduce(s2_idx.mean(), scale=10)
                    ndvi   = stats.get('NDVI')
                    nbr    = stats.get('NBR')
                    logger.info(f"S2 stats: NDVI={ndvi} NBR={nbr}")
                    if ndvi is not None:
                        return {
                            'ndvi_mean': ndvi, 'nbr_mean': nbr,
                            'ndvi_series': series,
                            'optical_source': label,
                            'status': 'success',
                        }

            # Tentativas 3 & 4: Landsat 8/9 C2 L2
            for cloud_pct, days, label in [
                (30, 30, "Landsat 8/9 (cloud<30%)"),
                (60, 60, "Landsat 8/9 (cloud<60% 60d)"),
            ]:
                start = self.end_date - timedelta(days=days)
                landsat = (ee.ImageCollection('LANDSAT/LC09/C02/T1_L2')
                           .filterBounds(self.geometry)
                           .filterDate(start, self.end_date)
                           .filter(ee.Filter.lt('CLOUD_COVER', cloud_pct))
                           .merge(
                               ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
                               .filterBounds(self.geometry)
                               .filterDate(start, self.end_date)
                               .filter(ee.Filter.lt('CLOUD_COVER', cloud_pct))
                           ))

                n = landsat.size().getInfo()
                logger.info(f"{label}: {n} imagens")

                if n >= 1:
                    def add_ls_indices(img):
                        optical = img.select(['SR_B4', 'SR_B5', 'SR_B7']) \
                                     .multiply(2.75e-5).add(-0.2)
                        red  = optical.select('SR_B4')
                        nir  = optical.select('SR_B5')
                        swir = optical.select('SR_B7')
                        ndvi = nir.subtract(red).divide(nir.add(red)).rename('NDVI')
                        nbr  = nir.subtract(swir).divide(nir.add(swir)).rename('NBR')
                        return img.addBands([ndvi, nbr])

                    ls_idx = landsat.map(add_ls_indices)
                    series = self._extract_series(ls_idx, 'NDVI')
                    stats  = self._reduce(ls_idx.mean(), scale=30)
                    ndvi   = stats.get('NDVI')
                    nbr    = stats.get('NBR')
                    logger.info(f"Landsat stats: NDVI={ndvi} NBR={nbr}")
                    if ndvi is not None:
                        return {
                            'ndvi_mean': ndvi, 'nbr_mean': nbr,
                            'ndvi_series': series,
                            'optical_source': label,
                            'status': 'success',
                        }

            # Tentativa 5: MODIS MOD13Q1
            start_modis = self.end_date - timedelta(days=48)
            modis = (ee.ImageCollection('MODIS/061/MOD13Q1')
                     .filterBounds(self.geometry)
                     .filterDate(start_modis, self.end_date)
                     .select('NDVI'))

            n_modis = modis.size().getInfo()
            logger.info(f"MODIS MOD13Q1: {n_modis} composicoes")

            if n_modis >= 1:
                modis_scaled = modis.map(lambda img: img.multiply(0.0001).rename('NDVI'))
                series = self._extract_series(modis_scaled, 'NDVI')
                stats  = self._reduce(modis_scaled.mean(), scale=250)
                ndvi   = stats.get('NDVI')
                logger.info(f"MODIS NDVI: {ndvi}")
                if ndvi is not None:
                    return {
                        'ndvi_mean': ndvi,
                        'nbr_mean':  None,
                        'ndvi_series': series,
                        'optical_source': 'MODIS MOD13Q1 250m',
                        'status': 'success',
                    }

            logger.error("Todas as fontes opticas falharam")
            return {
                'ndvi_mean': None, 'nbr_mean': None,
                'ndvi_series': [],
                'optical_source': 'indisponivel',
                'status': 'no_data',
            }

        except Exception as e:
            logger.error(f"Erro optico: {e}", exc_info=True)
            return {
                'ndvi_mean': None, 'nbr_mean': None,
                'ndvi_series': [],
                'optical_source': 'error',
                'status': 'error',
            }

    def _extract_series(self, col: ee.ImageCollection, band: str) -> List[float]:
        SENTINEL = -9999
        def extract(img):
            val = img.select(band).reduceRegion(
                reducer=ee.Reducer.mean(), geometry=self.geometry,
                scale=10, maxPixels=1e13, bestEffort=True, tileScale=4,
            ).get(band)
            return img.set('_val', ee.Algorithms.If(
                ee.Algorithms.IsEqual(val, None), SENTINEL, val
            ))
        try:
            raw   = col.map(extract).aggregate_array('_val').getInfo() or []
            clean = [v for v in raw if v is not None and v != SENTINEL]
            logger.info(f"Serie {band}: {len(clean)} pontos")
            return clean
        except Exception as e:
            logger.warning(f"Extracao de serie {band} falhou: {e}")
            return []


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
        p        = []
        nbr      = data.get('nbr_mean')
        ndvi     = data.get('ndvi_mean')
        rain7d   = data.get('precipitation_sum_7d')
        rain7d_f = float(rain7d) if rain7d is not None else 0.0

        rvi_series = data.get('rvi_series') or []
        rvi_z      = calc_zscore_python(rvi_series)
        rvi_mean   = data.get('rvi_mean')

        optical_miss = (ndvi is None and nbr is None)

        # MODO RADAR: analise exclusiva via SAR
        if optical_miss:
            if rvi_mean is None:
                p.append("DADOS PARCIAIS: Nenhuma fonte disponivel nesta janela orbital. Aguarde a proxima passagem.")
                return p

            p.append(
                f"MODO RADAR ATIVO — Analise exclusiva via Sentinel-1 SAR "
                f"(nuvens bloquearam Sentinel-2, Landsat e MODIS nesta janela)."
            )

            if rvi_z is not None:
                if rvi_z < -1.5:
                    p.append(f"ANOMALIA CRITICA (Z={rvi_z:.2f}): RVI esta {abs(rvi_z):.1f} desvios abaixo da media. Avalie irrigacao, drenagem ou dano foliar.")
                elif rvi_z < -1.0:
                    p.append(f"ATENCAO RADAR (Z={rvi_z:.2f}): Leve queda na estrutura vegetal. Monitore nas proximas passagens (6-12 dias).")
                else:
                    p.append(f"RADAR NORMAL (Z={rvi_z:.2f}): Estrutura vegetal dentro do padrao historico desta fazenda.")
            else:
                if rvi_mean < 0.2:
                    p.append(f"ATENCAO: RVI={rvi_mean:.3f} — solo possivelmente exposto ou vegetacao muito esparsa.")
                elif rvi_mean > 0.5:
                    p.append(f"RVI={rvi_mean:.3f} — vegetacao radar densa, estrutura aparentemente normal.")
                else:
                    p.append(f"RVI={rvi_mean:.3f} — estrutura moderada. Z-Score disponivel apos mais passagens do Sentinel-1.")
            return p

        # MODO NORMAL: indices opticos disponiveis
        if ndvi is not None and float(ndvi) < 0.3:
            p.append(f"CRITICO: NDVI={float(ndvi):.3f} indica vegetacao muito degradada ou solo exposto.")
        if nbr is not None and float(nbr) < 0.1:
            p.append("VULNERABILIDADE CRITICA: Resposta espectral indica dessecacao severa. Alto risco de ignicao ou degradacao do solo.")
        if ndvi is not None and float(ndvi) < 0.4 and rain7d_f > 20:
            p.append("ALERTA NUTRICIONAL: Baixo vigor vegetativo com solo umido — possivel deficiencia nutricional ou ataque de pragas.")
        if rvi_z is not None and rvi_z < -1.5:
            p.append(f"ANOMALIA RADAR (Z={rvi_z:.2f}): RVI esta {abs(rvi_z):.1f} desvios abaixo da media dos ultimos 30 dias. Avalie irrigacao ou drenagem.")

        src = data.get('optical_source', '')
        if src and 'Sentinel-2' not in src and src not in ('indisponivel', 'error', ''):
            p.append(f"Fonte optica: {src} (resolucao reduzida, tendencia valida).")

        if not p:
            p.append("Monitoramento Normal — Sem acoes urgentes requeridas.")
        return p


# ─── EMAIL ────────────────────────────────────────────────────────────────────
def fmtf(val, decimals=3, suffix=""):
    if val is None:
        return "N/D"
    return f"{float(val):.{decimals}f}{suffix}"

class EmailNotifier:
    def send_report(self, recipient_email: str, farm_name: str, data: Dict, prescriptions: List[str]) -> bool:
        try:
            msg            = MIMEMultipart()
            msg['From']    = EMAIL_SENDER
            msg['To']      = recipient_email
            msg['Subject'] = f"AgroScan - Relatorio Diario: {farm_name}"

            rvi_series  = data.get('rvi_series') or []
            rvi_z       = calc_zscore_python(rvi_series)
            data_hoje   = datetime.now().strftime('%d/%m/%Y')
            src         = data.get('optical_source') or 'N/D'
            radar_mode  = data.get('ndvi_mean') is None and data.get('nbr_mean') is None

            alert_color = (
                "red"    if any("CRITICA" in p or "ANOMALIA CRITICA" in p for p in prescriptions) else
                "orange" if any("ALERTA" in p or "ANOMALIA" in p or "ATENCAO" in p for p in prescriptions) else
                "green"
            )

            radar_banner = ""
            if radar_mode:
                radar_banner = """
                <div style="background:#1a0050;border:2px solid #7c3aed;border-radius:8px;padding:14px;margin-bottom:20px;">
                  <h3 style="color:#c084fc;margin:0 0 6px;">MODO RADAR ATIVO</h3>
                  <p style="color:#ddd6fe;margin:0;font-size:.9em;">Cobertura de nuvens impediu imagens opticas. Analise via SAR Sentinel-1.</p>
                </div>"""

            html_body = f"""
            <html><body style="font-family:Arial,sans-serif;margin:0;padding:20px;background:#f5f5f5;">
            <div style="max-width:600px;margin:0 auto;background:white;padding:30px;border-radius:10px;">
              <div style="text-align:center;border-bottom:3px solid #2E8B57;padding-bottom:20px;margin-bottom:30px;">
                <h1 style="color:#2E8B57;margin:0;">AgroScan</h1>
                <p style="color:#666;margin:5px 0;"><strong>Fazenda:</strong> {farm_name}</p>
                <p style="color:#666;margin:5px 0;"><strong>Data:</strong> {data_hoje}</p>
              </div>
              {radar_banner}
              <div style="background:#e8f5e8;padding:20px;border-radius:8px;margin-bottom:20px;">
                <h3 style="color:#2E8B57;margin-top:0;">Precipitacao (CHIRPS + ERA5 + GPM)</h3>
                <p><strong>Ultimos 7 dias:</strong> {fmtf(data.get('precipitation_sum_7d'), 1, ' mm')}{'*' if data.get('data_gap') else ''}</p>
                <p><strong>Ultimos 30 dias:</strong> {fmtf(data.get('precipitation_sum_30d'), 1, ' mm')}{'*' if data.get('data_gap') else ''}</p>
                <p style="font-size:.85em;color:#888;"><strong>Fontes:</strong> {', '.join(data.get('precip_sources') or ['N/D'])}</p>
              </div>
              <div style="background:#e8f0ff;padding:20px;border-radius:8px;margin-bottom:20px;">
                <h3 style="color:#1e40af;margin-top:0;">Indices de Vegetacao</h3>
                <p><strong>NDVI:</strong> {fmtf(data.get('ndvi_mean'))} &nbsp; <em style="font-size:.85em;color:#888;">Fonte: {src}</em></p>
                <p><strong>NBR:</strong> {fmtf(data.get('nbr_mean'))}</p>
                <p><strong>RVI (Radar):</strong> {fmtf(data.get('rvi_mean'))} — <strong>Z-Score:</strong> {fmtf(rvi_z, 2)}</p>
              </div>
              <div style="background:#fff3cd;padding:20px;border-radius:8px;border-left:5px solid {alert_color};">
                <h3 style="color:#856404;margin-top:0;">Prescricoes e Recomendacoes</h3>
            """
            for pr in prescriptions:
                html_body += f"<p style='padding:10px;background:white;border-radius:5px;margin:8px 0;'>{pr}</p>"

            html_body += """
              </div>
              <div style="text-align:center;margin-top:30px;color:#666;">
                <p><em>Relatorio gerado automaticamente pelo AgroScan | Google Earth Engine</em></p>
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
            firebase_admin.initialize_app()

        has_critical = any("CRITICA" in p for p in prescriptions)
        has_alert    = any("ALERTA" in p or "ATENCAO" in p or "ANOMALIA" in p for p in prescriptions)
        title = (
            f"Alerta Critico — {farm_name}" if has_critical else
            f"Atencao — {farm_name}"        if has_alert    else
            f"Analise concluida — {farm_name}"
        )
        body = prescriptions[0][:200] if prescriptions else "Analise orbital concluida."

        fcm_messaging.send(fcm_messaging.Message(
            notification=fcm_messaging.Notification(title=title, body=body),
            token=fcm_token,
            android=fcm_messaging.AndroidConfig(priority='high'),
            apns=fcm_messaging.APNSConfig(
                payload=fcm_messaging.APNSPayload(aps=fcm_messaging.Aps(sound='default'))
            ),
        ))
        logger.info(f"Push enviado — token ...{fcm_token[-8:]}")
        return True
    except Exception as e:
        logger.warning(f"Push falhou: {e}")
        return False


# ─── PROCESS FARM ─────────────────────────────────────────────────────────────
def process_single_farm(farm_data: Dict) -> Dict:
    logger.info(f"Iniciando analise: {farm_data.get('nome_fazenda')}")

    proc = AgroDataProcessor(ee.Geometry.Polygon([farm_data['coordinates']]))
    pd   = proc.get_precipitation_data()
    rd   = proc.get_radar_data()
    od   = proc.get_optical_data()

    for name, result in [('precipitacao', pd), ('radar', rd), ('optico', od)]:
        if result.get('status') in ('error', 'no_data'):
            logger.warning(f"Modulo {name}: {result.get('status')} — dados parciais.")

    cd = {
        'precipitation_sum_7d':  pd.get('precipitation_sum_7d'),
        'precipitation_sum_30d': pd.get('precipitation_sum_30d'),
        'data_gap':              pd.get('data_gap', False),
        'precip_sources':        pd.get('sources', []),
        'ndvi_mean':             od.get('ndvi_mean'),
        'nbr_mean':              od.get('nbr_mean'),
        'ndvi_series':           od.get('ndvi_series', []),
        'optical_source':        od.get('optical_source'),
        'rvi_mean':              rd.get('rvi_mean'),
        'vv_mean':               rd.get('vv_mean'),
        'rvi_series':            rd.get('rvi_series', []),
    }

    failed  = [k for k, v in cd.items() if v is None]
    success = [k for k, v in cd.items() if v is not None]
    if failed:
        logger.warning(f"Indices com falha: {failed}")
    logger.info(f"Indices obtidos: {success}")

    pr       = PrescriptionEngine.generate_prescription(cd)
    email_ok = EmailNotifier().send_report(farm_data['email'], farm_data['nome_fazenda'], cd, pr)
    if not email_ok:
        pr.append("Analise salva, mas e-mail nao foi entregue.")

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
        fcm_token = req.get('fcm_token')
        fid       = FirestoreManager.save_farm(req['email'], req['nome_fazenda'], req['coordinates'])
        result    = process_single_farm({
            'farm_id':      fid,
            'email':        req['email'],
            'nome_fazenda': req['nome_fazenda'],
            'coordinates':  req['coordinates'],
            'fcm_token':    fcm_token,
        })
        result['farm_id'] = fid
        return json.dumps(result), 200, CORS_HEADERS
    except Exception as e:
        logger.error(f"Erro agroscan_monitor: {e}")
        return json.dumps({'error': str(e)}), 500, CORS_HEADERS


@functions_framework.http
def get_farm_status(request):
    preflight = handle_preflight(request)
    if preflight:
        return preflight
    try:
        req     = request.get_json()
        farm_id = req.get('farm_id')
        if not farm_id:
            return json.dumps({'error': 'farm_id obrigatorio'}), 400, CORS_HEADERS

        hist = (db.collection('fazendas').document(farm_id)
                  .collection('historico')
                  .order_by('data_analise', direction=firestore.Query.DESCENDING)
                  .limit(1).stream())

        docs = list(hist)
        if not docs:
            return json.dumps({'status': 'pending'}), 200, CORS_HEADERS

        data = docs[0].to_dict().get('dados_earth_engine', {})
        return json.dumps({'status': 'ready', 'data': data}), 200, CORS_HEADERS

    except Exception as e:
        logger.error(f"Erro get_farm_status: {e}")
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