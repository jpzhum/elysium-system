# Guia de manutenção

## Arquitetura

`bot.py` é somente o entrypoint. `elysium.application` coordena o bot, os cogs,
as views persistentes e o servidor HTTP. Configurações pertencem a
`elysium.config`; regras de cargos a `elysium.services`; interações do Discord a
`elysium.cogs` e `elysium.views`; e o health check a `elysium.web`.

## Comandos

```console
python -m pip install -r requirements.txt
python bot.py
python -m compileall bot.py elysium
python -c "import bot, elysium.application, elysium.config, elysium.constants, elysium.logging_setup, elysium.cogs.portal, elysium.views.concluir_entrada, elysium.services.role_service, elysium.web.health"
```

## Padrões de código

- Use Python 3.13, type hints e responsabilidades pequenas e explícitas.
- Evite estado global mutável, dependências circulares e duplicação de regras.
- Mantenha `bot.py` pequeno e não conecte ao Discord durante importações.
- Testes não devem depender de um servidor Discord real.
- Não altere textos ou comportamento visível sem uma necessidade documentada.

## Segurança

- Nunca registre tokens, segredos ou o conteúdo completo do ambiente.
- Não solicite intents privilegiados nem permissão de Administrador.
- O bot precisa somente das permissões necessárias, como Gerenciar cargos.
- Não crie banco de dados ou integrações externas sem decisão arquitetural.

## Variáveis de ambiente

Toda leitura e validação deve permanecer em `elysium/config.py`. São obrigatórias:
`DISCORD_TOKEN`, `GUILD_ID`, `HABITANTE_ROLE_ID`, `VISITANTE_ROLE_ID` e
`PANEL_CHANNEL_ID`. `PORT` é opcional e usa `10000` por padrão. Preserve esses
nomes para manter compatibilidade com o Render.

Nunca versione `.env`. Atualize somente `.env.example`, usando valores fictícios,
quando novas configurações forem deliberadamente introduzidas.

## Componentes persistentes

`custom_id` é uma interface persistente e não pode ser alterada após publicação.
Preserve exatamente `elysium:portal:concluir_entrada:v1` enquanto os painéis
existentes precisarem continuar funcionando após reinicializações.
