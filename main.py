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

PROJECT_ID = 'agroscan-ipe'
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
        headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '3600'
        }
        return ('', 204, headers)
    return None
# ──────────────────────────────────────────────────────────────────────────────


class FirestoreManager:
    @staticmethod
    def save_farm(email: str, farm_name: str, coordinates: List) -> str:
        farm_id = str(uuid.uuid4())
        farm_data = {
            'email': email,
            'nome_fazenda': farm_name,
            'coordinates': json.dumps(coordinates),
            'data_ativacao': datetime.now(),
            'status': 'active',
            'ultima_analise': None,
            'total_analises': 0
        }
        db.collection('fazendas').document(farm_id).set(farm_data)
        return farm_id

    @staticmethod
    def get_active_farms() -> List[Dict]:
        farms_ref = db.collection('fazendas').where('status', '==', 'active')
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
            'data_analise': datetime.now(),
            'dados_earth_engine': analysis_data,
            'prescricoes': prescriptions,
            'email_enviado': True
        })
        return True


class AgroDataProcessor:
    def __init__(self, geometry: ee.Geometry):
        self.geometry = geometry
        self.end_date = datetime.now()
        self.start_date = self.end_date - timedelta(days=30)

    def get_precipitation_data(self) -> Dict:
        try:
            chirps = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY').filterDate(self.start_date, self.end_date).select('precipitation')
            p7_img = chirps.filterDate(self.end_date - timedelta(days=7), self.end_date).sum()
            p30_img = chirps.sum()
            p7 = p7_img.reduceRegion(reducer=ee.Reducer.sum(), geometry=self.geometry, scale=5000).get('precipitation').getInfo()
            p30 = p30_img.reduceRegion(reducer=ee.Reducer.sum(), geometry=self.geometry, scale=5000).get('precipitation').getInfo()
            return {'precipitation_sum_7d': p7 or 0, 'precipitation_sum_30d': p30 or 0, 'status': 'success'}
        except Exception:
            return {'status': 'error'}

    def get_radar_data(self) -> Dict:
        try:
            s1 = (ee.ImageCollection('COPERNICUS/S1_GRD')
                  .filterDate(self.start_date, self.end_date)
                  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
                  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
                  .filter(ee.Filter.eq('instrumentMode', 'IW'))
                  .select(['VV', 'VH']))
            def calc_rvi(img):
                return img.addBands(img.select('VH').multiply(4).divide(img.select('VV').add(img.select('VH'))).rename('RVI'))
            stats = s1.map(calc_rvi).mean().reduceRegion(reducer=ee.Reducer.mean(), geometry=self.geometry, scale=10).getInfo()
            vv = stats.get('VV', 0) if stats else 0
            return {'vv_mean': vv, 'vh_mean': stats.get('VH', 0) if stats else 0, 'rvi_mean': stats.get('RVI', 0) if stats else 0, 'recent_vv_values': [vv], 'status': 'success'}
        except Exception:
            return {'status': 'error'}

    def get_optical_data(self) -> Dict:
        try:
            s2 = (ee.ImageCollection('COPERNICUS/S2_HARMONIZED')
                  .filterDate(self.start_date, self.end_date)
                  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30))
                  .select(['B4', 'B8', 'B12']))
            def calc_idx(img):
                return img.addBands([
                    img.normalizedDifference(['B8', 'B4']).rename('NDVI'),
                    img.normalizedDifference(['B8', 'B12']).rename('NBR')
                ])
            stats = s2.map(calc_idx).mean().reduceRegion(reducer=ee.Reducer.mean(), geometry=self.geometry, scale=10).getInfo()
            ndvi = stats.get('NDVI', 0) if stats else 0
            return {'ndvi_mean': ndvi, 'nbr_mean': stats.get('NBR', 0) if stats else 0, 'ndvi_series': [ndvi], 'status': 'success'}
        except Exception:
            return {'status': 'error'}


class PrescriptionEngine:
    @staticmethod
    def generate_prescription(data: Dict) -> List[str]:
        p = []
        # ✅ BLINDAGEM: garante que None vire 0.0 antes da matemática
        nbr = float(data.get('nbr_mean') or 0)
        ndvi = float(data.get('ndvi_mean') or 0)
        vv = float(data.get('vv_mean') or 0)
        rain7d = float(data.get('precipitation_sum_7d') or 0)

        if nbr < 0.1: 
            p.append("VULNERABILIDADE CRÍTICA: Resposta espectral indica dessecação severa da vegetação. Alto risco de ignição ou degradação de solo.")
        if ndvi < 0.4 and rain7d > 20: 
            p.append("ALERTA NUTRICIONAL: Baixo vigor com solo úmido.")
        if vv < -14 and rain7d < 10: 
            p.append("AÇÃO AUTOMATIZADA: Solo seco. Sugestão de irrigação.")
        if not p: 
            p.append("Monitoramento Normal - Sem ações urgentes requeridas.")
        return p


class EmailNotifier:
    def send_report(self, recipient_email: str, farm_name: str, data: Dict, prescriptions: List[str]):
        try:
            msg = MIMEMultipart()
            msg['From'] = EMAIL_SENDER
            msg['To'] = recipient_email
            msg['Subject'] = f"🌾 AgroScan - Relatório Diário: {farm_name}"

            p7   = float(data.get('precipitation_sum_7d') or 0)
            p30  = float(data.get('precipitation_sum_30d') or 0)
            ndvi = float(data.get('ndvi_mean') or 0)
            nbr  = float(data.get('nbr_mean') or 0)
            rvi  = float(data.get('rvi_mean') or 0)
            data_hoje = datetime.now().strftime('%d/%m/%Y')

            # ✅ LINHA CORRIGIDA (sem barra invertida para evitar erros de sintaxe)
            alert_color = "red" if any("VULNERABILIDADE" in p for p in prescriptions) else "orange" if any("ALERTA" in p for p in prescriptions) else "green"

            html_body = f"""
            <html>
            <body style="font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5;">
                <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                    <div style="text-align: center; border-bottom: 3px solid #2E8B57; padding-bottom: 20px; margin-bottom: 30px;">
                        <h1 style="color: #2E8B57; margin: 0;">🌾 AgroScan</h1>
                        <h2 style="color: #333; margin: 10px 0;">Relatório de Monitoramento Agrícola</h2>
                        <p style="color: #666; margin: 5px 0;"><strong>Fazenda:</strong> {farm_name}</p>
                        <p style="color: #666; margin: 5px 0;"><strong>Data:</strong> {data_hoje}</p>
                    </div>
                    <div style="background-color: #e8f5e8; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                        <h3 style="color: #2E8B57; margin-top: 0;">🌧️ Dados Meteorológicos</h3>
                        <p style="margin: 5px 0;"><strong>Precipitação últimos 7 dias:</strong> {p7:.1f} mm</p>
                        <p style="margin: 5px 0;"><strong>Precipitação últimos 30 dias:</strong> {p30:.1f} mm</p>
                    </div>
                    <div style="background-color: #e8f0ff; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                        <h3 style="color: #1e40af; margin-top: 0;">🌱 Índices de Vegetação</h3>
                        <p style="margin: 5px 0;"><strong>NDVI (Vigor das Plantas): {ndvi:.3f}</strong><br>
                        <span style="font-size: 0.9em; color: #555;">Mede a saúde e a fotossíntese da vegetação.</span></p>
                        <p style="margin: 15px 0 5px 0;"><strong>NBR (Risco de Fogo): {nbr:.3f}</strong><br>
                        <span style="font-size: 0.9em; color: #555;">Avalia o risco de incêndio na área monitorada.</span></p>
                        <p style="margin: 15px 0 5px 0;"><strong>RVI (Umidade/Biomassa): {rvi:.3f}</strong><br>
                        <span style="font-size: 0.9em; color: #555;">Análise via radar da umidade do solo e estrutura da cultura.</span></p>
                    </div>
                    <div style="background-color: #fff3cd; padding: 20px; border-radius: 8px; margin-bottom: 20px; border-left: 5px solid {alert_color};">
                        <h3 style="color: #856404; margin-top: 0;">📋 Prescrições e Recomendações</h3>
            """
            for p in prescriptions:
                html_body += f"<p style='margin: 10px 0; padding: 10px; background-color: white; border-radius: 5px;'>{p}</p>"

            html_body += """
                    </div>
                    <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; color: #666;">
                        <p><em>Relatório gerado automaticamente pelo AgroScan</em></p>
                        <p><small>Projeto de Inovações para Engenharia | Google Earth Engine API</small></p>
                    </div>
                </div>
            </body>
            </html>
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


def process_single_farm(farm_data: Dict) -> Dict:
    """Orquestrador principal — aplica Graceful Degradation.
    Garante que o processamento satelital e a persistência na Firestore
    nunca sejam interrompidos por falhas externas de e-mail.
    """
    # 1. Processamento dos dados espaciais (GCP / Earth Engine)
    proc = AgroDataProcessor(ee.Geometry.Polygon(farm_data['coordinates']))
    pd, rd, od = proc.get_precipitation_data(), proc.get_radar_data(), proc.get_optical_data()
    
    cd = {
        'precipitation_sum_7d': pd.get('precipitation_sum_7d', 0),
        'precipitation_sum_30d': pd.get('precipitation_sum_30d', 0),
        'ndvi_mean': od.get('ndvi_mean', 0),
        'nbr_mean': od.get('nbr_mean', 0),
        'rvi_mean': rd.get('rvi_mean', 0),
        'vv_mean': rd.get('vv_mean', 0),
        'ndvi_series': od.get('ndvi_series', []),
        'recent_vv_values': rd.get('recent_vv_values', [])
    }
    
    # 2. Geração das prescrições técnicas
    pr = PrescriptionEngine.generate_prescription(cd)
    
    # 3. Tenta enviar o e-mail e avalia o resultado
    email_sucesso = EmailNotifier().send_report(farm_data['email'], farm_data['nome_fazenda'], cd, pr)
    
    # Se o e-mail falhou, regista o aviso para o Firestore
    if not email_sucesso:
        logger.warning(f"Falha no e-mail para {farm_data['email']}.")
        pr.append("⚠️ NOTIFICAÇÃO: Análise concluída, mas o e-mail não pôde ser entregue. Os dados foram salvos no sistema.")
    
    # 4. Salva na Firestore (Garante redundância)
    FirestoreManager.save_analysis_result(farm_data['farm_id'], cd, pr)
    
    # 5. Resposta ao APK
    return {'status': 'success' if email_sucesso else 'email_error'}


@functions_framework.http
def agroscan_monitor(request):
    # ✅ CORS preflight
    preflight = handle_preflight(request)
    if preflight:
        return preflight

    try:
        req = request.get_json()
        fid = FirestoreManager.save_farm(req['email'], req['nome_fazenda'], req['coordinates'])
        result = process_single_farm({
            'farm_id': fid,
            'email': req['email'],
            'nome_fazenda': req['nome_fazenda'],
            'coordinates': req['coordinates']
        })
        return json.dumps(result), 200, CORS_HEADERS
    except Exception as e:
        logger.error(f"Erro agroscan_monitor: {e}")
        return json.dumps({'error': str(e)}), 500, CORS_HEADERS


@functions_framework.http
def daily_monitoring(request):
    # ✅ CORS preflight
    preflight = handle_preflight(request)
    if preflight:
        return preflight

    try:
        farms = FirestoreManager.get_active_farms()
        results = []
        for f in farms:
            results.append(process_single_farm(f))
        return json.dumps({'status': 'success', 'processed': len(farms), 'results': results}), 200, CORS_HEADERS
    except Exception as e:
        logger.error(f"Erro daily_monitoring: {e}")
        return json.dumps({'error': str(e)}), 500, CORS_HEADERS