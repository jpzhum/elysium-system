# Elysium System — Render

Bot do Portal do Elysium preparado para execução contínua no Render.

## O que esta versão inclui

- botão persistente de conclusão da entrada;
- troca de `Visitante` por `Habitante`;
- resposta privada ao membro;
- endpoint HTTP `/health` para o Render;
- configuração por variáveis de ambiente;
- Python 3.13 definido por `.python-version`;
- Blueprint opcional em `render.yaml`.

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

Nunca envie o arquivo `.env` ao GitHub. No Render, o token deve ser cadastrado como variável de ambiente secreta.

## Teste

Quando os logs mostrarem `Conectado como Elysium System`, acesse a URL do serviço. A resposta esperada em `/health` é um JSON com `status: ok`.

Mantenha apenas uma instância do bot executando com o mesmo token.
