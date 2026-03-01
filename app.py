import streamlit as st
import folium
from folium import plugins
from streamlit_folium import st_folium
import requests
import json
from datetime import datetime

# Configuração da página
st.set_page_config(
    page_title="AgroScan - Monitoramento Agrícola Inteligente",
    page_icon="🌾",
    layout="wide"
)

# CSS customizado para melhor aparência
st.markdown("""
<style>
    .main-header {
        font-size: 2.5rem;
        color: #2E8B57;
        text-align: center;
        margin-bottom: 2rem;
    }
    .info-box {
        background-color: #f0f8f0;
        color: #333333;
        padding: 1rem;
        border-radius: 10px;
        border-left: 5px solid #2E8B57;
        margin: 1rem 0;
    }
    .success-message {
        background-color: #d4edda;
        color: #155724;
        padding: 1rem;
        border-radius: 10px;
        border-left: 5px solid #28a745;
    }
    .error-message {
        background-color: #f8d7da;
        color: #721c24;
        padding: 1rem;
        border-radius: 10px;
        border-left: 5px solid #dc3545;
    }
</style>
""", unsafe_allow_html=True)

# Header
st.markdown('<h1 class="main-header">🌾 AgroScan</h1>', unsafe_allow_html=True)
st.markdown('<p style="text-align: center; color: #666;">Monitoramento Agrícola Inteligente com Satélites</p>', unsafe_allow_html=True)

# Informações do sistema
st.markdown("""
<div class="info-box">
    <h3>📋 Como funciona:</h3>
    <ol>
        <li>Desenhe o polígono de sua fazenda no mapa abaixo</li>
        <li>Insira seu e-mail para receber alertas diários</li>
        <li>Clique em "Ativar Monitoramento" para começar</li>
    </ol>
    <p><strong>🛰️ Análise diária:</strong> Precipitação, umidade do solo, vigor das plantas e risco de fogo</p>
</div>
""", unsafe_allow_html=True)

# Sidebar para configurações
with st.sidebar:
    st.header("⚙️ Configurações")
    
    # Campo de e-mail
    email = st.text_input(
        "📧 E-mail para alertas",
        placeholder="exemplo@fazenda.com",
        help="Você receberá relatórios diários neste e-mail"
    )
    
    # Informações da fazenda
    st.subheader("📍 Informações da Fazenda")
    nome_fazenda = st.text_input(
        "Nome da Fazenda",
        placeholder="Fazenda Exemplo",
        help="Nome identificador da sua propriedade"
    )
    
    # Botão de ativação
    activate_button = st.button(
        "🚀 Ativar Monitoramento",
        type="primary",
        disabled=not email or not nome_fazenda,
        help="Desenhe o polígono no mapa e preencha os dados acima"
    )

# Mapa interativo
st.header("🗺️ Desenhe sua Fazenda")

# Criar mapa centrado no Brasil
m = folium.Map(
    location=[-15.8267, -54.9296],  # Centro do Brasil
    zoom_start=5,
    tiles="OpenStreetMap"
)

# Adicionar controle de desenho
draw = plugins.Draw(
    draw_options={
        'polyline': False,
        'rectangle': False,
        'polygon': True,
        'circle': False,
        'marker': False,
        'circlemarker': False,
    },
    edit_options={'edit': True, 'remove': True}
)

m.add_child(draw)

# Exibir mapa
map_data = st_folium(m, width=700, height=500)

# Processar ativação do monitoramento
if activate_button:
    # Verificar se polígono foi desenhado
    if 'all_drawings' in map_data and map_data['all_drawings']:
        polygon_data = map_data['all_drawings'][0]
        
        # Extrair coordenadas do polígono
        coordinates = polygon_data['geometry']['coordinates'][0]
        
        # Preparar dados para enviar ao backend
        payload = {
            'email': email,
            'nome_fazenda': nome_fazenda,
            'coordinates': coordinates,
            'data_ativacao': datetime.now().isoformat(),
            'project_id': 'agroscan-ipe'
        }
        
        try:
            # Enviar dados para o Cloud Functions
            # NOTA: Substitua URL abaixo pela URL real da sua Cloud Function
            function_url = "https://us-central1-agroscan-ipe.cloudfunctions.net/agroscan_monitor"
            
            with st.spinner("🚀 Ativando monitoramento..."):
                response = requests.post(
                    function_url,
                    json=payload,
                    timeout=30
                )
                
                if response.status_code == 200:
                    st.markdown("""
                    <div class="success-message">
                        <h3>✅ Monitoramento Ativado com Sucesso!</h3>
                        <p>Você receberá o primeiro relatório em até 24 horas.</p>
                        <p><strong>E-mail:</strong> {}</p>
                        <p><strong>Fazenda:</strong> {}</p>
                        <p><strong>Área monitorada:</strong> {} pontos</p>
                    </div>
                    """.format(email, nome_fazenda, len(coordinates)), unsafe_allow_html=True)
                else:
                    st.markdown(f"""
                    <div class="error-message">
                        <h3>❌ Erro ao ativar monitoramento</h3>
                        <p>Status Code: {response.status_code}</p>
                        <p>Resposta: {response.text}</p>
                    </div>
                    """, unsafe_allow_html=True)
                    
        except requests.exceptions.RequestException as e:
            st.markdown(f"""
            <div class="error-message">
                <h3>❌ Erro de conexão</h3>
                <p>Não foi possível conectar ao servidor: {str(e)}</p>
                <p>Verifique sua conexão com a internet e tente novamente.</p>
            </div>
            """, unsafe_allow_html=True)
            
        except Exception as e:
            st.markdown(f"""
            <div class="error-message">
                <h3>❌ Erro inesperado</h3>
                <p>Ocorreu um erro: {str(e)}</p>
            </div>
            """, unsafe_allow_html=True)
    else:
        st.markdown("""
        <div class="error-message">
            <h3>⚠️ Polígono não desenhado</h3>
            <p>Por favor, desenhe o polígono de sua fazenda no mapa antes de ativar o monitoramento.</p>
        </div>
        """, unsafe_allow_html=True)

# Informações adicionais
with st.expander("📊 Sobre as Análises Realizadas"):
    st.markdown("""
    **🛰️ Satélites e Sensores Utilizados:**
    
    - **CHIRPS (Precipitação):** Dados diários de chuva com resolução de 5km
    - **Sentinel-1 Radar (Umidade):** Bandas VV e VH para análise de umidade do solo e biomassa
    - **Sentinel-2 Óptico (Vigor):** NDVI para vigor das plantas e NBR para risco de fogo
    
    **🔍 Índices Calculados:**
    
    - **NDVI (Normalized Difference Vegetation Index):** (B8 - B4) / (B8 + B4)
    - **NBR (Normalized Burn Ratio):** (B8 - B12) / (B8 + B12)  
    - **RVI (Radar Vegetation Index):** 4 * VH / (VV + VH)
    
    **⏰ Frequência:** Análise diária com dados dos últimos 30 dias
    """)

# Rodapé
st.markdown("---")
st.markdown("""
<div style="text-align: center; color: #666; margin-top: 2rem;">
    <p>🌾 AgroScan - Monitoramento Agrícola Inteligente</p>
    <p>Projeto de Inovações para Engenharia | Google Earth Engine API</p>
</div>
""", unsafe_allow_html=True)