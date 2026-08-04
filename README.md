# Elysium System 1.3.1 — Render

Bot do Portal do Elysium preparado para execução contínua no Render.

## O que esta versão inclui

- botão persistente de conclusão da entrada;
- troca de `Visitante` por `Habitante`;
- resposta privada ao membro;
- endpoints HTTP `/` e `/health` para o Render;
- comando administrativo e privado `/status`;
- auditoria opcional em canal privado, além dos logs estruturados no stdout;
- códigos de incidente para erros inesperados;
- configuração por variáveis de ambiente;
- Python 3.13 definido por `.python-version`;
- Blueprint opcional em `render.yaml`.

## Estrutura

```text
bot.py                         # entrypoint
elysium/
├── application.py             # ciclo de vida do bot
├── config.py                  # leitura e validação do ambiente
├── constants.py               # identidade e IDs estáveis
├── errors.py                  # tratamento central de interações
├── logging_setup.py           # logging central
├── runtime.py                 # uptime e estado de conexão
├── cogs/portal.py             # comando /publicar_entrada
├── cogs/system.py             # comando /status
├── services/audit_service.py  # auditoria segura no Discord
├── services/role_service.py   # regras para alteração de cargos
├── utils/time_format.py       # duração legível
├── views/concluir_entrada.py  # botão persistente
└── web/health.py              # servidor HTTP de saúde
```

## Execução local

## Expedições premium

Configure `EXPEDITION_CHANNEL_ID` para habilitar o recurso. Um administrador usa
`/publicar_expedicoes` no canal configurado para publicar o painel; o banner
opcional vem de `EXPEDITION_BANNER_URL`. Habitantes e administradores podem criar,
participar e sair. O proprietário e administradores podem editar e encerrar;
quando `HOST_ROLE_ID` está configurado, o Anfitrião também pode encerrar cartões de
terceiros, mas não editá-los.

O bot precisa de Ver canal, Ler histórico, Enviar mensagens e Inserir links no
canal. Não requer Administrador nem intents privilegiados. Cada usuário mantém no
máximo uma expedição ativa, e o organizador integra automaticamente a lista de
participantes.

Não há banco de dados: cada embed é a fonte do estado. Após restart, os botões
dinâmicos continuam operando sem registrar uma view por mensagem, e o índice é
reconstruído de modo lazy examinando no máximo as 1000 mensagens recentes do bot.
Cartões fora dessa janela podem não ser encontrados; duplicatas e cartões inválidos
são auditados e nunca removidos automaticamente.

### Salas de voz temporárias

Com `EXPEDITION_VOICE_CATEGORY_ID` configurado, cada cartão ativo recebe o botão
**Sala de voz**. O organizador, um administrador ou o cargo `HOST_ROLE_ID` cria no
máximo uma sala privada; depois disso, participantes autorizados recebem um link
ephemeral. Entradas e saídas sincronizam overwrites sem mover membros para a sala.

O bot precisa de **Gerenciar canais**, **Ver canal**, **Conectar** e **Mover
membros**, mas não de Administrador. `TEMP_VOICE_BITRATE_KBPS` (padrão `384`, de
8 a 384) é limitado pelo servidor. `TEMP_VOICE_EMPTY_TIMEOUT_SECONDS` (padrão
`600`, de 60 a 3600) controla a exclusão automática de salas vazias.

Após restart, os índices são reconstruídos pelo field `Sala de voz`; salas vazias
recebem um timeout completo novo e salas ocupadas nunca são apagadas no startup.
O comando ephemeral `/sincronizar_salas_expedicao` reconcilia referências e órfãs.
Sem banco, o tempo vazio anterior e cartões além das 1000 mensagens recentes não
são recuperados.

## Boletim institucional

O grupo `/boletim criar` abre um formulário e apresenta uma prévia ephemeral antes
de qualquer publicação. O administrador escolhe entre nenhuma menção, o cargo
Eventos ou `@everyone`, além de poder substituir o canal padrão. Somente a
confirmação em **Publicar** envia a mensagem; a prévia usa menções desativadas.

Podem criar boletins membros com `Gerenciar servidor` ou cargos presentes em
`BOLETIM_MANAGER_ROLE_IDS`. Como as permissões padrão do slash command usam
`manage_guild`, cargos gerenciais sem essa permissão devem receber acesso ao comando
nas configurações de integrações do Discord. A autorização também é sempre
revalidada em tempo de execução.

O bot precisa de Ver canal, Enviar mensagens e Inserir links no destino. Para
`eventos` ou `everyone`, também precisa da permissão de mencionar `@everyone`,
`@here` e todos os cargos. `EXPEDICOES_CHANNEL_ID` fica disponível como referência
de configuração para recursos futuros e não é inserido automaticamente no boletim.

## Apresentações premium

Configure `PRESENTATION_CHANNEL_ID` para habilitar o recurso e, opcionalmente,
`PRESENTATION_BANNER_URL` com uma URL HTTP(S) para a imagem grande do painel. Um
administrador publica o painel com `/publicar_apresentacoes` no canal configurado.
Membros Visitante ou Habitante podem criar uma apresentação pelo modal, editar a
mesma mensagem e excluí-la mediante confirmação.

O bot precisa de Ver canal, Ler histórico, Enviar mensagens, Inserir links e
Gerenciar mensagens no canal de apresentações. Não precisa de Administrador nem de
intents privilegiados. Nesta versão não há banco de dados: o índice em memória é
reconstruído de forma lazy na primeira operação após reiniciar. Duplicatas
pré-existentes são auditadas, mas não removidas automaticamente.

## Execução local

1. Execute `instalar.bat`.
2. Copie `.env.example` para `.env` e preencha os valores.
3. Execute `iniciar.bat`.

Também é possível iniciar diretamente no ambiente configurado:

```console
python bot.py
```

## Deploy manual no Render

1. Publique esta pasta em um repositório privado no GitHub.
2. No Render, crie um **Web Service** conectado ao repositório.
3. Runtime: `Python 3`.
4. Build Command: `pip install -r requirements.txt`.
5. Start Command: `python bot.py`.
6. Health Check Path: `/health`.
7. Cadastre as variáveis:
   - `DISCORD_TOKEN`
   - `GUILD_ID`
   - `HABITANTE_ROLE_ID`
   - `VISITANTE_ROLE_ID`
   - `PANEL_CHANNEL_ID`
   - `LOG_CHANNEL_ID` (opcional)
   - `PRESENTATION_CHANNEL_ID` (opcional)
   - `PRESENTATION_BANNER_URL` (opcional)
   - `EXPEDITION_CHANNEL_ID` (opcional)
   - `EXPEDITION_BANNER_URL` (opcional)
   - `HOST_ROLE_ID` (opcional)
   - `EXPEDITION_VOICE_CATEGORY_ID` (opcional; vazio desativa as salas)
   - `TEMP_VOICE_EMPTY_TIMEOUT_SECONDS` (opcional; padrão `600`)
   - `TEMP_VOICE_BITRATE_KBPS` (opcional; padrão `384`)
   - `BOLETIM_CHANNEL_ID` (opcional; canal padrão)
   - `EVENTOS_ROLE_ID` (opcional; necessário para a menção Eventos)
   - `BOLETIM_MANAGER_ROLE_IDS` (opcional; IDs separados por vírgula)
   - `EXPEDICOES_CHANNEL_ID` (opcional; uso futuro)
8. Faça o deploy.

O Render fornece `PORT` ao Web Service. Localmente, quando ela não é definida, o
servidor usa a porta `10000`.

Nunca envie o arquivo `.env` ao GitHub. No Render, o token deve ser cadastrado como
variável de ambiente secreta.

## Configuração

`DISCORD_TOKEN`, `GUILD_ID`, `HABITANTE_ROLE_ID`, `VISITANTE_ROLE_ID` e
`PANEL_CHANNEL_ID` são obrigatórias. `PORT` é opcional e usa `10000` localmente.
`LOG_CHANNEL_ID` também é opcional: quando preenchida, deve apontar para um canal
privado onde o bot possa enviar mensagens e embeds. Se estiver vazia ou o canal
estiver inacessível, o bot continua operando e mantém a auditoria no stdout.
`EXPEDITION_CHANNEL_ID` e `HOST_ROLE_ID` aceitam snowflakes válidos ou vazio.
`EXPEDITION_BANNER_URL` aceita vazio ou URL iniciada por HTTP(S).

O `/status` é restrito a administradores do servidor configurado e sempre responde
de forma ephemeral. Ele mostra versão, latência, uptime, servidor, comandos e
disponibilidade do canal de logs, sem expor IDs ou segredos.

## Health check

Além das chaves existentes, o payload inclui `presentations_configured`,
`expeditions_configured`, `expedition_voice_configured` e
`active_expedition_voice_rooms`, sem expor IDs.

`GET /` e `GET /health` retornam o mesmo JSON. Além de `status`, `service` e
`discord_ready`, a resposta inclui `version`, `uptime_seconds`, `latency_ms`,
`guild_ready` e `log_channel_configured`. A latência é `null` antes da conexão.

## Validação

Os testes não conectam ao Discord e cobrem configuração, contratos persistentes,
validação, embeds, comandos, health check e propriedade das apresentações.

```console
python -m compileall bot.py elysium tests
python -m unittest discover -s tests -v
python -c "import bot, elysium.application, elysium.config, elysium.constants, elysium.errors, elysium.logging_setup, elysium.runtime, elysium.cogs.portal, elysium.cogs.system, elysium.views.concluir_entrada, elysium.services.audit_service, elysium.services.role_service, elysium.utils.time_format, elysium.web.health"
git diff --check
```

Quando os logs mostrarem `Conectado como Elysium System`, acesse a URL do serviço.
A resposta esperada em `/health` contém as chaves descritas acima. No Render,
confirme também uma única auditoria de inicialização, teste `/status` e valide uma
reconexão controlada. O stdout deve manter o formato
`timestamp | level | logger | message`.

Mantenha apenas uma instância do bot executando com o mesmo token.
