# Elysium System

## Visão geral do projeto

Elysium System é um bot de automação comunitária para Discord, desenvolvido em
Python 3.13 com `discord.py` e `aiohttp`. O projeto organiza onboarding,
publicações institucionais, apresentações e expedições em componentes modulares,
com execução contínua como Web Service no Render.

A versão atual é `1.3.1`. O repositório não inclui credenciais, IDs de produção
ou dados da comunidade.

## Principais funcionalidades

- portal persistente de onboarding, com troca controlada dos cargos Visitante e
  Habitante e respostas privadas ao membro;
- boletins institucionais com formulário, prévia privada, confirmação e controle
  explícito de menções;
- apresentações criadas e editadas por modal, com exclusão confirmada,
  propriedade validada e uma apresentação por usuário;
- expedições com criação e edição por modal, participação dinâmica, encerramento
  controlado e uma expedição ativa por organizador;
- salas de voz privadas e temporárias vinculadas a expedições, com sincronização
  de participantes, limpeza de salas vazias e reconciliação administrativa;
- views persistentes e itens dinâmicos que continuam atendendo mensagens
  publicadas após reinicializações;
- auditoria em stdout e, opcionalmente, em canal privado do Discord;
- códigos aleatórios de incidente para erros inesperados;
- comandos administrativos para publicar painéis, diagnosticar e reconciliar
  salas e consultar o estado operacional em `/status`;
- servidor HTTP mínimo para health checks do Render;
- testes automatizados sem conexão com um servidor Discord real.

## Arquitetura

`bot.py` é apenas o entrypoint. `elysium.application` monta o cliente, registra
cogs e views e coordena o ciclo de vida do servidor HTTP. Configuração,
interações, regras de domínio e infraestrutura permanecem separadas.

```text
.
├── bot.py                         # entrypoint e tratamento de falhas fatais
├── render.yaml                    # Blueprint do Web Service
├── requirements.txt               # dependências Python
├── elysium/
│   ├── application.py             # composição e ciclo de vida do bot
│   ├── config.py                  # leitura e validação do ambiente
│   ├── constants.py               # identidade, versão e custom IDs estáveis
│   ├── errors.py                  # erros de interação e incidentes
│   ├── logging_setup.py           # configuração central de logs
│   ├── runtime.py                 # estado operacional em memória
│   ├── cogs/                      # slash commands
│   ├── modals/                    # formulários de apresentação e expedição
│   ├── models/                    # modelos serializáveis em embeds
│   ├── services/                  # cargos, auditoria, apresentações e expedições
│   ├── utils/                     # validação, nomes e formatação
│   ├── views/                     # componentes persistentes e confirmações
│   └── web/health.py              # endpoints públicos de saúde
└── tests/                          # testes unitários e de contratos do Discord
```

As mensagens e os embeds do Discord são a fonte persistente do estado de
apresentações e expedições. Não há banco de dados nem integração externa de
persistência.

## Permissões do Discord

O bot não solicita permissão de Administrador e desativa os intents privilegiados
de membros, presenças e conteúdo de mensagens. O intent de estado de voz é usado
para a limpeza das salas temporárias.

Conceda somente as permissões exigidas pelos recursos habilitados:

- portal: Ver canal, Enviar mensagens, Inserir links e Gerenciar cargos; o cargo
  do bot deve estar acima de Visitante e Habitante;
- apresentações e expedições: Ver canal, Ler histórico, Enviar mensagens e
  Inserir links; apresentações também exigem Gerenciar mensagens;
- salas temporárias: Ver canal, Gerenciar canais, Gerenciar cargos, Conectar,
  Falar, Vídeo, Usar detecção de voz e Mover membros na categoria configurada;
- boletins: Ver canal, Enviar mensagens e Inserir links; menções a Eventos ou
  `@everyone` também exigem a permissão correspondente de menção;
- auditoria no Discord: Ver canal, Enviar mensagens e Inserir links no canal
  privado configurado.

Os comandos de publicação, diagnóstico, reconciliação e `/status` revalidam
acesso administrativo em tempo de execução. `/boletim criar` aceita Gerenciar
servidor ou um cargo configurado em `BOLETIM_MANAGER_ROLE_IDS`.

## Variáveis de ambiente

Copie `.env.example` para `.env` apenas no ambiente local. Nunca versione esse
arquivo nem reutilize os valores fictícios do exemplo.

| Variável | Obrigatória | Finalidade |
| --- | --- | --- |
| `DISCORD_TOKEN` | sim | token secreto da aplicação Discord |
| `GUILD_ID` | sim | servidor autorizado |
| `HABITANTE_ROLE_ID` | sim | cargo concedido no onboarding |
| `VISITANTE_ROLE_ID` | sim | cargo removido no onboarding |
| `PANEL_CHANNEL_ID` | sim | canal do portal |
| `PORT` | não | porta HTTP; padrão `10000` |
| `LOG_CHANNEL_ID` | não | canal privado de auditoria |
| `PRESENTATION_CHANNEL_ID` | não | habilita apresentações |
| `PRESENTATION_BANNER_URL` | não | banner HTTP(S) do painel de apresentações |
| `EXPEDITION_CHANNEL_ID` | não | habilita expedições |
| `EXPEDITION_BANNER_URL` | não | banner HTTP(S) do painel de expedições |
| `HOST_ROLE_ID` | não | cargo com ações adicionais em expedições |
| `EXPEDITION_VOICE_CATEGORY_ID` | não | habilita salas temporárias |
| `TEMP_VOICE_EMPTY_TIMEOUT_SECONDS` | não | limpeza de sala vazia; `60` a `3600`, padrão `600` |
| `TEMP_VOICE_BITRATE_KBPS` | não | bitrate solicitado; `8` a `384`, padrão `384` |
| `BOLETIM_CHANNEL_ID` | não | destino padrão de boletins |
| `EVENTOS_ROLE_ID` | não | cargo usado pela opção de menção Eventos |
| `BOLETIM_MANAGER_ROLE_IDS` | não | cargos autorizados, separados por vírgula |
| `EXPEDICOES_CHANNEL_ID` | não | referência preservada por compatibilidade; sem uso operacional atual |

IDs devem ser snowflakes válidos. URLs opcionais aceitam apenas HTTP(S). Toda a
leitura e validação ocorre em `elysium/config.py`.

## Desenvolvimento local

Requer Python 3.13.

```console
python -m venv .venv
.venv\Scripts\activate
python -m pip install -r requirements.txt
copy .env.example .env
python bot.py
```

No Windows, `instalar.bat` prepara o ambiente e `iniciar.bat` inicia o serviço.
Mantenha somente uma instância usando o mesmo token.

## Testes

```console
python -m compileall bot.py elysium tests
python -m unittest discover -s tests -v
python -c "import bot, elysium.application, elysium.config, elysium.constants, elysium.errors, elysium.logging_setup, elysium.runtime, elysium.cogs.portal, elysium.cogs.system, elysium.views.concluir_entrada, elysium.services.audit_service, elysium.services.role_service, elysium.web.health"
git diff --check
```

Os testes cobrem configuração, contratos persistentes, validação de conteúdo,
apresentações, boletins, expedições, salas temporárias e health check.

## Deploy no Render

O repositório pode ser público desde que nenhum segredo seja commitado. Revise o
histórico antes da publicação, mantenha `.env` ignorado e cadastre
`DISCORD_TOKEN` como variável secreta no painel do Render.

Para usar o Blueprint, conecte o repositório ao Render e aplique `render.yaml`.
Para configuração manual, crie um Web Service com:

- runtime: Python;
- build command: `pip install -r requirements.txt`;
- start command: `python bot.py`;
- health check path: `/health`;
- variáveis obrigatórias e opcionais definidas conforme a tabela acima.

O Render fornece `PORT`; localmente, a aplicação usa `10000` quando a variável não
está definida. O Blueprint não contém valores de produção e usa `sync: false` para
configurações que devem ser preenchidas no ambiente.

## Health checks

`GET /` e `GET /health` são rotas somente de leitura e retornam HTTP 200 com o
mesmo payload público mínimo:

```json
{
  "status": "ok",
  "service": "elysium-system",
  "version": "1.3.1"
}
```

O endpoint confirma que o processo HTTP responde, preservando compatibilidade com
o Render sem expor latência, uptime, IDs, configuração de módulos ou contagens
operacionais. Administradores consultam detalhes de Discord, latência, uptime,
comandos, auditoria e salas temporárias pelo `/status`, cuja resposta é privada.

## Modelo de segurança

- segredos e configuração são recebidos exclusivamente por variáveis de ambiente;
- `.env`, chaves privadas, bancos locais, logs e artefatos de execução são
  ignorados pelo Git;
- não há token, webhook, client secret, ID de produção ou domínio privado no
  código versionado;
- não há rota HTTP mutável nem painel administrativo público;
- menções são desativadas em prévias, respostas e conteúdo gerado por usuários,
  exceto na publicação de boletim explicitamente confirmada;
- apresentações rejeitam links, convites e menções e validam a propriedade antes
  de editar ou excluir;
- locks por usuário e por expedição reduzem operações concorrentes duplicadas;
- tracebacks ficam no stdout; respostas públicas recebem apenas um código de
  incidente aleatório, sem incorporar dados do usuário;
- a auditoria em canal é opcional e falhas nela não interrompem o bot.

## Limitações operacionais

- apresentações e expedições não usam banco; o estado depende das mensagens e
  embeds existentes no Discord;
- os índices são reconstruídos de forma lazy a partir de até 1000 mensagens
  recentes do bot; itens fora dessa janela podem não ser encontrados;
- duplicatas e cartões inválidos são auditados, mas não removidos automaticamente;
- após reinício, o tempo já transcorrido de uma sala vazia não é recuperado; um
  novo timeout completo é iniciado, e salas ocupadas não são apagadas no startup;
- o bitrate efetivo das salas é limitado pelo nível de boost do servidor;
- `EXPEDICOES_CHANNEL_ID` está validada por compatibilidade, mas não aciona uma
  funcionalidade nesta versão;
- o health check mede disponibilidade do processo HTTP, não prontidão detalhada
  da conexão com o Discord; essa condição é observada pelo `/status` e pelos logs.

## Status do projeto

Versão `1.3.1`, mantida para operação real em uma única comunidade Discord. Os
recursos opcionais permanecem desabilitados quando suas variáveis não são
configuradas. Mudanças em custom IDs publicados exigem migração compatível, pois
eles fazem parte do contrato persistente com mensagens existentes.

## Changelog

Consulte [CHANGELOG.md](CHANGELOG.md) para o histórico de alterações.
