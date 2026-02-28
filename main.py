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

# Configuração de logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configurações do projeto
PROJECT_ID = 'agroscan-ipe'
EMAIL_SENDER = 'agroscanipe@gmail.com'

# Inicialização do Google Earth Engine
try:
    ee.Initialize(project=PROJECT_ID)
    logger.info("Google Earth Engine inicializado com sucesso")
except Exception as e:
    logger.error(f"Erro ao inicializar Earth Engine: {str(e)}")
    raise

# Inicialização do Firestore
try:
    db = firestore.Client(project=PROJECT_ID)
    logger.info("Firestore inicializado com sucesso")
except Exception as e:
    logger.error(f"Erro ao inicializar Firestore: {str(e)}")
    raise

class FirestoreManager:
    """Gerenciador de operações no Firestore"""
    
    @staticmethod
    def save_farm(email: str, farm_name: str, coordinates: List) -> str:
        """Salva nova fazenda no Firestore"""
        try:
            farm_id = str(uuid.uuid4())
            
            farm_data = {
                'email': email,
                'nome_fazenda': farm_name,
                'coordinates': coordinates,
                'data_ativacao': datetime.now(),
                'status': 'active',
                'ultima_analise': None,
                'total_analises': 0
            }
            
            # Salvar na coleção fazendas
            doc_ref = db.collection('fazendas').document(farm_id)
            doc_ref.set(farm_data)
            
            logger.info(f"Fazenda {farm_name} salva com ID: {farm_id}")
            return farm_id
            
        except GoogleAPICallError as e:
            logger.error(f"Erro do Firestore ao salvar fazenda: {str(e)}")
            raise
        except Exception as e:
            logger.error(f"Erro ao salvar fazenda: {str(e)}")
            raise
    
    @staticmethod
    def get_active_farms() -> List[Dict]:
        """Busca todas as fazendas ativas no Firestore"""
        try:
            farms_ref = db.collection('fazendas').where('status', '==', 'active')
            docs = farms_ref.stream()
            
            active_farms = []
            for doc in docs:
                farm_data = doc.to_dict()
                farm_data['farm_id'] = doc.id
                active_farms.append(farm_data)
            
            logger.info(f"Encontradas {len(active_farms)} fazendas ativas")
            return active_farms
            
        except GoogleAPICallError as e:
            logger.error(f"Erro do Firestore ao buscar fazendas: {str(e)}")
            return []
        except Exception as e:
            logger.error(f"Erro ao buscar fazendas ativas: {str(e)}")
            return []
    
    @staticmethod
    def save_analysis_result(farm_id: str, analysis_data: Dict, prescriptions: List[str]) -> bool:
        """Salva resultado da análise no histórico da fazenda"""
        try:
            # Criar subcoleção historico
            historico_ref = db.collection('fazendas').document(farm_id).collection('historico')
            
            analysis_doc = {
                'data_analise': datetime.now(),
                'dados_earth_engine': analysis_data,
                'prescricoes': prescriptions,
                'email_enviado': True
            }
            
            # Adicionar documento ao histórico
            historico_ref.add(analysis_doc)
            
            # Atualizar metadados da fazenda
            farm_ref = db.collection('fazendas').document(farm_id)
            farm_ref.update({
                'ultima_analise': datetime.now(),
                'total_analises': firestore.Increment(1)
            })
            
            logger.info(f"Análise salva para fazenda {farm_id}")
            return True
            
        except GoogleAPICallError as e:
            logger.error(f"Erro do Firestore ao salvar análise: {str(e)}")
            return False
        except Exception as e:
            logger.error(f"Erro ao salvar resultado da análise: {str(e)}")
            return False
    
    @staticmethod
    def update_farm_status(farm_id: str, status: str) -> bool:
        """Atualiza status da fazenda"""
        try:
            farm_ref = db.collection('fazendas').document(farm_id)
            farm_ref.update({'status': status})
            logger.info(f"Status da fazenda {farm_id} atualizado para: {status}")
            return True
        except Exception as e:
            logger.error(f"Erro ao atualizar status da fazenda: {str(e)}")
            return False

class AgroDataProcessor:
    """Classe principal para processamento de dados agrícolas"""
    
    def __init__(self, geometry: ee.Geometry):
        self.geometry = geometry
        self.end_date = datetime.now()
        self.start_date = self.end_date - timedelta(days=30)
        
    def get_precipitation_data(self) -> Dict:
        """Coleta dados de precipitação CHIRPS"""
        try:
            logger.info("Coletando dados de precipitação CHIRPS")
            
            # Coleção CHIRPS Daily
            chirps = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY') \
                .filterDate(self.start_date, self.end_date) \
                .select('precipitation')
            
            # Soma total nos últimos 7 e 30 dias
            last_7_days = chirps.filterDate(
                self.end_date - timedelta(days=7), self.end_date
            ).sum()
            
            last_30_days = chirps.sum()
            
            precip_7d = last_7_days.reduceRegion(
                reducer=ee.Reducer.sum(),
                geometry=self.geometry,
                scale=5000,
                maxPixels=1e9
            ).get('precipitation_sum')
            
            precip_30d = last_30_days.reduceRegion(
                reducer=ee.Reducer.sum(),
                geometry=self.geometry,
                scale=5000,
                maxPixels=1e9
            ).get('precipitation_sum')
            
            return {
                'precipitation_sum_7d': precip_7d or 0,
                'precipitation_sum_30d': precip_30d or 0,
                'status': 'success'
            }
            
        except Exception as e:
            logger.error(f"Erro ao coletar dados de precipitação: {str(e)}")
            return {'status': 'error', 'error': str(e)}
    
    def get_radar_data(self) -> Dict:
        """Coleta dados do Sentinel-1 Radar (VV, VH, RVI)"""
        try:
            logger.info("Coletando dados do Sentinel-1 Radar")
            
            # Coleção Sentinel-1 GRD
            s1 = ee.ImageCollection('COPERNICUS/S1_GRD') \
                .filterDate(self.start_date, self.end_date) \
                .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV')) \
                .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH')) \
                .filter(ee.Filter.eq('instrumentMode', 'IW')) \
                .select(['VV', 'VH'])
            
            # Calcular RVI (Radar Vegetation Index)
            def calculate_rvi(image):
                vv = image.select('VV')
                vh = image.select('VH')
                rvi = vh.multiply(4).divide(vv.add(vh)).rename('RVI')
                return image.addBands(rvi)
            
            s1_rvi = s1.map(calculate_rvi)
            
            # Redução estatística
            radar_stats = s1_rvi.reduceRegion(
                reducer=ee.Reducer.mean(),
                geometry=self.geometry,
                scale=10,
                maxPixels=1e9
            ).getInfo()
            
            # Últimas leituras de VV
            recent_images = s1.sort('system:time_start', False).limit(3)
            vv_values = []
            
            for i in range(3):
                try:
                    image = recent_images.toList(3).get(i)
                    vv_mean = ee.Image(image).select('VV').reduceRegion(
                        reducer=ee.Reducer.mean(),
                        geometry=self.geometry,
                        scale=10,
                        maxPixels=1e9
                    ).get('VV')
                    if vv_mean:
                        vv_values.append(vv_mean.getInfo())
                except:
                    continue
            
            return {
                'vv_mean': radar_stats.get('VV', 0),
                'vh_mean': radar_stats.get('VH', 0),
                'rvi_mean': radar_stats.get('RVI', 0),
                'recent_vv_values': vv_values,
                'status': 'success'
            }
            
        except Exception as e:
            logger.error(f"Erro ao coletar dados do radar: {str(e)}")
            return {'status': 'error', 'error': str(e)}
    
    def get_optical_data(self) -> Dict:
        """Coleta dados do Sentinel-2 Óptico (NDVI, NBR)"""
        try:
            logger.info("Coletando dados do Sentinel-2 Óptico")
            
            # Coleção Sentinel-2 Harmonized
            s2 = ee.ImageCollection('COPERNICUS/S2_HARMONIZED') \
                .filterDate(self.start_date, self.end_date) \
                .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30)) \
                .select(['B4', 'B8', 'B12'])
            
            # Funções para calcular índices
            def calculate_ndvi(image):
                ndvi = image.normalizedDifference(['B8', 'B4']).rename('NDVI')
                return image.addBands(ndvi)
            
            def calculate_nbr(image):
                nbr = image.normalizedDifference(['B8', 'B12']).rename('NBR')
                return image.addBands(nbr)
            
            # Aplicar cálculos
            s2_indices = s2.map(calculate_ndvi).map(calculate_nbr)
            
            # Redução estatística
            optical_stats = s2_indices.reduceRegion(
                reducer=ee.Reducer.mean(),
                geometry=self.geometry,
                scale=10,
                maxPixels=1e9
            ).getInfo()
            
            # Série temporal de NDVI
            ndvi_collection = s2_indices.select('NDVI')
            
            # Obter últimos valores de NDVI
            recent_ndvi = ndvi_collection.sort('system:time_start', False).limit(10)
            ndvi_list = recent_ndvi.reduceColumns(ee.Reducer.toList(), ['NDVI']).get('list').getInfo()
            
            return {
                'ndvi_mean': optical_stats.get('NDVI', 0),
                'nbr_mean': optical_stats.get('NBR', 0),
                'ndvi_series': ndvi_list or [],
                'status': 'success'
            }
            
        except Exception as e:
            logger.error(f"Erro ao coletar dados ópticos: {str(e)}")
            return {'status': 'error', 'error': str(e)}

class PrescriptionEngine:
    """Motor de prescrição agronômica"""
    
    @staticmethod
    def analyze_fire_risk(nbr_value: float) -> Optional[str]:
        """Analisa risco de fogo baseado no NBR"""
        if nbr_value < 0.1:
            return "URGENTE: Inspeção de Incêndio/Queimada na área."
        return None
    
    @staticmethod
    def analyze_water_stress(ndvi_series: List, precipitation_7d: float) -> Optional[str]:
        """Analisa estresse hídrico/nutricional"""
        if len(ndvi_series) < 3:
            return None
        
        # Verificar queda contínua nas últimas 3 leituras
        recent_values = ndvi_series[-3:]
        is_declining = all(
            recent_values[i] > recent_values[i+1] 
            for i in range(len(recent_values)-1)
        )
        
        if is_declining:
            if precipitation_7d > 20:
                return "ALERTA NUTRICIONAL: Queda contínua de vigor com solo úmido. Realizar amostragem de solo."
            else:
                return "ALERTA DE ESTRESSE: Queda de vigor associada à falta de chuvas."
        
        return None
    
    @staticmethod
    def analyze_irrigation_need(vv_values: List, precipitation_7d: float) -> Optional[str]:
        """Analisa necessidade de irrigação automatizada"""
        if len(vv_values) < 3:
            return None
        
        # Verificar VV persistentemente abaixo de -14
        vv_below_threshold = all(vv < -14 for vv in vv_values)
        
        if vv_below_threshold and precipitation_7d < 10:
            return "AÇÃO AUTOMATIZADA: Solo permanentemente seco. Sugestão de acionamento de sistema de irrigação."
        
        return None
    
    @staticmethod
    def generate_prescription(data: Dict) -> List[str]:
        """Gera prescrições baseadas nos dados analisados"""
        prescriptions = []
        
        # Análise de risco de fogo
        fire_alert = PrescriptionEngine.analyze_fire_risk(data.get('nbr_mean', 0))
        if fire_alert:
            prescriptions.append(fire_alert)
        
        # Análise de estresse hídrico/nutricional
        stress_alert = PrescriptionEngine.analyze_water_stress(
            data.get('ndvi_series', []),
            data.get('precipitation_sum_7d', 0)
        )
        if stress_alert:
            prescriptions.append(stress_alert)
        
        # Análise de necessidade de irrigação
        irrigation_alert = PrescriptionEngine.analyze_irrigation_need(
            data.get('recent_vv_values', []),
            data.get('precipitation_sum_7d', 0)
        )
        if irrigation_alert:
            prescriptions.append(irrigation_alert)
        
        # Se não há alertas, status normal
        if not prescriptions:
            prescriptions.append("Monitoramento Normal - Sem ações urgentes requeridas.")
        
        return prescriptions

class EmailNotifier:
    """Sistema de envio de e-mails"""
    
    def __init__(self):
        self.smtp_server = "smtp.gmail.com"
        self.smtp_port = 587
        self.sender_email = EMAIL_SENDER
        self.app_password = os.environ.get('GMAIL_APP_PASSWORD')
    
    def send_report(self, recipient_email: str, farm_name: str, data: Dict, prescriptions: List[str]):
        """Envia relatório diário por e-mail"""
        try:
            if not self.app_password:
                raise ValueError("GMAIL_APP_PASSWORD não configurado nas variáveis de ambiente")
            
            # Criar mensagem
            msg = MIMEMultipart()
            msg['From'] = self.sender_email
            msg['To'] = recipient_email
            msg['Subject'] = f"🌾 AgroScan - Relatório Diário {farm_name} - {datetime.now().strftime('%d/%m/%Y')}"
            
            # Corpo do e-mail
            body = self._generate_email_body(farm_name, data, prescriptions)
            msg.attach(MIMEText(body, 'html'))
            
            # Enviar e-mail
            with smtplib.SMTP(self.smtp_server, self.smtp_port) as server:
                server.starttls()
                server.login(self.sender_email, self.app_password)
                server.send_message(msg)
            
            logger.info(f"E-mail enviado com sucesso para {recipient_email}")
            return True
            
        except Exception as e:
            logger.error(f"Erro ao enviar e-mail: {str(e)}")
            return False
    
    def _generate_email_body(self, farm_name: str, data: Dict, prescriptions: List[str]) -> str:
        """Gera corpo HTML do e-mail"""
        
        # Formatar dados
        precip_7d = data.get('precipitation_sum_7d', 0)
        precip_30d = data.get('precipitation_sum_30d', 0)
        ndvi = data.get('ndvi_mean', 0)
        nbr = data.get('nbr_mean', 0)
        rvi = data.get('rvi_mean', 0)
        
        # Determinar cor dos alertas
        alert_color = "red" if "URGENTE" in str(prescriptions) else "orange" if "ALERTA" in str(prescriptions) else "green"
        
        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif; margin: 20px; background-color: #f5f5f5;">
            <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                
                <div style="text-align: center; border-bottom: 3px solid #2E8B57; padding-bottom: 20px; margin-bottom: 30px;">
                    <h1 style="color: #2E8B57; margin: 0;">🌾 AgroScan</h1>
                    <h2 style="color: #333; margin: 10px 0;">Relatório de Monitoramento Agrícola</h2>
                    <p style="color: #666; margin: 5px 0;"><strong>Fazenda:</strong> {farm_name}</p>
                    <p style="color: #666; margin: 5px 0;"><strong>Data:</strong> {datetime.now().strftime('%d/%m/%Y')}</p>
                </div>
                
                <div style="background-color: #e8f5e8; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                    <h3 style="color: #2E8B57; margin-top: 0;">🌧️ Dados Meteorológicos</h3>
                    <p><strong>Precipitação últimos 7 dias:</strong> {precip_7d:.1f} mm</p>
                    <p><strong>Precipitação últimos 30 dias:</strong> {precip_30d:.1f} mm</p>
                </div>
                
                <div style="background-color: #e8f0ff; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                    <h3 style="color: #1e40af; margin-top: 0;">🌱 Índices de Vegetação</h3>
                    <p><strong>NDVI (Vigor das Plantas):</strong> {ndvi:.3f}</p>
                    <p><strong>NBR (Risco de Fogo):</strong> {nbr:.3f}</p>
                    <p><strong>RVI (Umidade/Biomassa):</strong> {rvi:.3f}</p>
                </div>
                
                <div style="background-color: #fff3cd; padding: 20px; border-radius: 8px; margin-bottom: 20px; border-left: 5px solid {alert_color};">
                    <h3 style="color: #856404; margin-top: 0;">📋 Prescrições e Recomendações</h3>
        """
        
        for prescription in prescriptions:
            html_body += f"<p style='margin: 10px 0; padding: 10px; background-color: white; border-radius: 5px;'>{prescription}</p>"
        
        html_body += f"""
                </div>
                
                <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; color: #666;">
                    <p><em>Relatório gerado automaticamente pelo AgroScan</em></p>
                    <p><small>Projeto de Inovações para Engenharia | Google Earth Engine API</small></p>
                </div>
                
            </div>
        </body>
        </html>
        """
        
        return html_body

def process_single_farm(farm_data: Dict) -> Dict:
    """Processa análise para uma única fazenda"""
    try:
        farm_id = farm_data['farm_id']
        email = farm_data['email']
        farm_name = farm_data['nome_fazenda']
        coordinates = farm_data['coordinates']
        
        logger.info(f"Processando fazenda {farm_name} ({farm_id})")
        
        # Converter coordenadas para geometria Earth Engine
        geometry = ee.Geometry.Polygon(coordinates)
        
        # Processar dados
        processor = AgroDataProcessor(geometry)
        
        # Coletar dados de todas as fontes
        precipitation_data = processor.get_precipitation_data()
        radar_data = processor.get_radar_data()
        optical_data = processor.get_optical_data()
        
        # Consolidar dados
        consolidated_data = {
            'precipitation_sum_7d': precipitation_data.get('precipitation_sum_7d', 0),
            'precipitation_sum_30d': precipitation_data.get('precipitation_sum_30d', 0),
            'ndvi_mean': optical_data.get('ndvi_mean', 0),
            'nbr_mean': optical_data.get('nbr_mean', 0),
            'rvi_mean': radar_data.get('rvi_mean', 0),
            'ndvi_series': optical_data.get('ndvi_series', []),
            'recent_vv_values': radar_data.get('recent_vv_values', [])
        }
        
        # Gerar prescrições
        prescriptions = PrescriptionEngine.generate_prescription(consolidated_data)
        
        # Enviar e-mail
        notifier = EmailNotifier()
        email_sent = notifier.send_report(email, farm_name, consolidated_data, prescriptions)
        
        # Salvar resultado no Firestore
        analysis_saved = FirestoreManager.save_analysis_result(farm_id, consolidated_data, prescriptions)
        
        return {
            'farm_id': farm_id,
            'farm_name': farm_name,
            'status': 'success',
            'email_sent': email_sent,
            'analysis_saved': analysis_saved,
            'prescriptions': prescriptions,
            'data_processed': {
                'precipitation': precipitation_data.get('status') == 'success',
                'radar': radar_data.get('status') == 'success',
                'optical': optical_data.get('status') == 'success'
            }
        }
        
    except Exception as e:
        logger.error(f"Erro ao processar fazenda {farm_data.get('farm_name', 'unknown')}: {str(e)}")
        return {
            'farm_id': farm_data.get('farm_id', 'unknown'),
            'farm_name': farm_data.get('nome_fazenda', 'unknown'),
            'status': 'error',
            'error': str(e)
        }

@functions_framework.http
def agroscan_monitor(request):
    """Função principal do Cloud Functions - acionada pelo frontend"""
    
    try:
        # Parse request data
        request_json = request.get_json()
        
        if not request_json:
            return json.dumps({'error': 'Dados não fornecidos'}), 400
        
        email = request_json.get('email')
        farm_name = request_json.get('nome_fazenda')
        coordinates = request_json.get('coordinates')
        
        if not all([email, farm_name, coordinates]):
            return json.dumps({'error': 'Dados incompletos'}), 400
        
        logger.info(f"Recebida solicitação para {farm_name} - {email}")
        
        # Salvar fazenda no Firestore
        try:
            farm_id = FirestoreManager.save_farm(email, farm_name, coordinates)
            logger.info(f"Fazenda salva com ID: {farm_id}")
        except Exception as e:
            logger.error(f"Erro ao salvar fazenda no Firestore: {str(e)}")
            return json.dumps({
                'error': 'Erro ao salvar fazenda no banco de dados',
                'details': str(e)
            }), 500
        
        # Processar primeira análise imediatamente
        farm_data = {
            'farm_id': farm_id,
            'email': email,
            'nome_fazenda': farm_name,
            'coordinates': coordinates
        }
        
        analysis_result = process_single_farm(farm_data)
        
        # Retornar resposta
        response_data = {
            'status': 'success',
            'message': 'Fazenda cadastrada e primeira análise realizada com sucesso',
            'farm_id': farm_id,
            'analysis_result': analysis_result,
            'timestamp': datetime.now().isoformat()
        }
        
        return json.dumps(response_data), 200
        
    except Exception as e:
        logger.error(f"Erro no processamento: {str(e)}")
        return json.dumps({
            'status': 'error',
            'message': f'Erro no processamento: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }), 500

@functions_framework.http
def daily_monitoring(request):
    """Função para monitoramento diário agendado - acionada pelo Cloud Scheduler"""
    
    try:
        logger.info("Iniciando monitoramento diário agendado")
        
        # Buscar todas as fazendas ativas no Firestore
        active_farms = FirestoreManager.get_active_farms()
        
        if not active_farms:
            logger.info("Nenhuma fazenda ativa encontrada para monitoramento")
            return json.dumps({
                'status': 'success',
                'message': 'Nenhuma fazenda ativa encontrada',
                'farms_processed': 0,
                'timestamp': datetime.now().isoformat()
            }), 200
        
        logger.info(f"Processando {len(active_farms)} fazendas ativas")
        
        # Processar cada fazenda
        results = []
        successful_count = 0
        error_count = 0
        
        for farm in active_farms:
            try:
                result = process_single_farm(farm)
                results.append(result)
                
                if result['status'] == 'success':
                    successful_count += 1
                else:
                    error_count += 1
                    logger.error(f"Erro na fazenda {farm['nome_fazenda']}: {result.get('error', 'Unknown error')}")
                
            except Exception as e:
                error_count += 1
                logger.error(f"Erro excepcional na fazenda {farm.get('nome_fazenda', 'unknown')}: {str(e)}")
                results.append({
                    'farm_id': farm.get('farm_id', 'unknown'),
                    'farm_name': farm.get('nome_fazenda', 'unknown'),
                    'status': 'error',
                    'error': str(e)
                })
        
        # Resumo do processamento
        summary = {
            'status': 'success',
            'message': 'Monitoramento diário concluído',
            'total_farms': len(active_farms),
            'successful_analyses': successful_count,
            'error_analyses': error_count,
            'results': results,
            'timestamp': datetime.now().isoformat()
        }
        
        logger.info(f"Monitoramento diário concluído: {successful_count} sucessos, {error_count} erros")
        
        return json.dumps(summary), 200
        
    except Exception as e:
        logger.error(f"Erro no monitoramento diário: {str(e)}")
        return json.dumps({
            'status': 'error',
            'message': f'Erro no monitoramento diário: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }), 500