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

Os custom IDs `elysium:presentation:create:v1`,
`elysium:presentation:edit:v1` e `elysium:presentation:delete:v1` também são
interfaces persistentes. `embed.author.url` identifica o proprietário; edição e
exclusão devem preservar e validar essa propriedade. Use locks por usuário contra
duplicidade. Rejeite links, convites e menções e nunca registre descrição,
interesses, atividade, expectativas ou conteúdo do modal. Use response/followup
conforme o estado da interação.

`custom_id` é uma interface persistente e não pode ser alterada após publicação.
Preserve exatamente `elysium:portal:concluir_entrada:v1` enquanto os painéis
existentes precisarem continuar funcionando após reinicializações.

Os cartões de expedição usam exclusivamente os custom IDs dinâmicos
`elysium:expedition:{join|leave|edit|close}:{expedition_id}`. O ID deve obedecer
`[a-f0-9]{8}` e esses contratos não podem ser alterados enquanto houver cartões
publicados. `DynamicItem` exige tratamento explícito de erro no próprio callback.

A mensagem e seu embed são a fonte persistente do estado das expedições; não
registre views individuais nem crie estado permanente paralelo. Use locks por
usuário na criação e por `expedition_id` nas mutações. Nunca registre jogo,
descrição, plataforma, horário informado, lista de participantes ou conteúdo dos
modais. Preserve todos os custom IDs estáticos e dinâmicos já publicados.

## Observabilidade e erros

- IDs de incidente usam oito caracteres hexadecimais maiúsculos e não carregam dados
  do usuário.
- Registre tracebacks somente no stdout; embeds recebem apenas contexto resumido e
  sanitizado, com menções desativadas.
- Nunca registre tokens, valores completos do ambiente ou outros dados sensíveis.
- `on_ready` pode ocorrer mais de uma vez; logs de inicialização devem ser emitidos
  somente uma vez por processo.
- Antes de responder uma interação, verifique `interaction.response.is_done()`;
  use `followup.send` quando a resposta inicial já tiver sido consumida.
