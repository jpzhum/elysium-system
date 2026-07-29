# Elysium System — Render

Bot do Portal do Elysium preparado para execução contínua no Render.

## O que esta versão inclui

- botão persistente de conclusão da entrada;
- troca de `Visitante` por `Habitante`;
- resposta privada ao membro;
- endpoints HTTP `/` e `/health` para o Render;
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
├── logging_setup.py           # logging central
├── cogs/portal.py             # comando /publicar_entrada
├── services/role_service.py   # regras para alteração de cargos
├── views/concluir_entrada.py  # botão persistente
└── web/health.py              # servidor HTTP de saúde
```

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
8. Faça o deploy.

O Render fornece `PORT` ao Web Service. Localmente, quando ela não é definida, o
servidor usa a porta `10000`.

Nunca envie o arquivo `.env` ao GitHub. No Render, o token deve ser cadastrado como
variável de ambiente secreta.

## Validação

```console
python -m compileall bot.py elysium
python -c "import bot, elysium.application, elysium.config, elysium.constants, elysium.logging_setup, elysium.cogs.portal, elysium.views.concluir_entrada, elysium.services.role_service, elysium.web.health"
```

Quando os logs mostrarem `Conectado como Elysium System`, acesse a URL do serviço.
A resposta esperada em `/health` contém `status`, `service` e `discord_ready`.

Mantenha apenas uma instância do bot executando com o mesmo token.
