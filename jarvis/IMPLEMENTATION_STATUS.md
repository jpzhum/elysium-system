# Estado da implementação — 25/10/2026

## Investigação de isolamento — novas funcionalidades suspensas

O [relatório de isolamento](docs/FAULT_ISOLATION.md) separa dez tons, dez perguntas
escritas sem captura, entrada/wake independentes e vinte turnos integrados. Um
único teste mantém bot, conexão nativa, player, manager e wake entre as fases;
transportes externos são controlados. A suíte passou com 752 testes, 40 arquivos
e um gate real ignorado; typecheck, lint e build aprovados.

Nenhuma causa nova foi demonstrada para justificar alteração de produção.
`4C09D8B0` e `B4C09469` continuam sem logs/SHA correlacionados. Não havia worker
ou credenciais locais para teste real. **Texto e reprodução em chamada real
precisam ser aprovados antes de reativar a complexidade de voz.** Sem refatoração,
dependências novas, aumento de timeout, push ou deploy nesta investigação.

## P0: áudio recebido, reprodução não iniciada

Commit local `7355ba9`: repara assinatura perdida/obsoleta no caminho de saída e
impede que pacotes descartados na limpeza contem como início ou drain completo.
`/ask`, `/tone` e `/status incidente` permitem correlacionar recurso, player,
assinatura, DAVE e a exceção original sanitizada. Nenhum timeout foi aumentado.

751 testes passaram em 39 arquivos, um gate real ignorado; typecheck, lint,
build e `git diff --check` aprovados. As duas sequências de 20 turnos mantêm o
mesmo AudioPlayer real com transporte controlado e falhas no terceiro/quarto
turnos. Texto: 18 concluídas, uma falha e uma parcial; tons: 18 concluídos e duas
falhas. Não houve captura, chamada paga, push ou deploy.

**Causa histórica em produção e aceitação audível ainda pendentes.** O aviso
significa PCM recebido sem primeiro pacote local observado; não identifica
sozinho um timeout ou falha do decoder de entrada. Causas reproduzidas, arquivos,
limitações e roteiro de `/tone` + `/ask` sem microfone:
[relatório P0](docs/P0_OUTPUT_PLAYBACK_RELIABILITY.md). Os números abaixo são históricos.

## Revisão V5.8: admissão de voz multiusuário

Preparação local para validação com Azrael/Kel. O teto padrão continua seis
wakes/minuto; dois consentidos recebem até três por ID. Follow-up concede uma
continuação por resposta e falha/retomada do áudio invalida a autorização antiga.
Fila cheia é verificada antes do STT; continuações do criador não ultrapassam
repetidamente um convidado aguardando atrás da resposta dele.

Avisos de voz são privados, atualizados por turno e limitados por pessoa/categoria;
fallback público é resumido e anônimo. Métricas recentes por falante numerado
distinguem admissão, quota, perguntas, entrega e playback. A frase exata de
desconexão pertence ao `/jarvis leave` autenticado no código local; sem SHA/log
do serviço não se atribui esse caminho à ocorrência real.

Render/configuração operacional desconhecidos; `audit:agent` retornou
`missing_configuration`. Sem push/deploy, alteração de agente/voz/prompt,
dependências ou Elysium Python. Causas, resultados finais, matriz A–T e rollback:
[relatório V5.8](docs/V58_MULTIUSER_RELIABILITY.md). Os números abaixo são históricos.

Gate local final: 740 testes passaram em 38 arquivos e um gate real foi ignorado;
23 testes de resistência sequencial, typecheck, lint, build, benchmark e
`git diff --check` aprovados. Commit de implementação `4912d6f`. A sequência
controlada de 20 turnos alternados terminou com 19 confirmadas, uma parcial
injetada e quatro chamadas wake; isso não certifica a experiência em chamada.

## Revisão V5.7: confiabilidade em conversas prolongadas

Entrega local com causas reproduzidas e suíte sequencial usando o mesmo runtime.
As correções preservam V5.6, voz, dependências, protocolos e consentimento; cobrem
socket perdido durante contexto, terminal/liberação únicos, tools tardias,
prefixo descartado ao exceder captura e renovação antes de reutilizar sessão
sem vida restante suficiente. Quota wake continua limitada; admissão por
participante reduz chamadas desperdiçadas após falas sem ativação.

`/jarvis status` distingue resumo, detalhes opcionais e incidentes técnicos;
playback parcial/expiração não são sucesso confirmado. O prompt local recebe
ajustes pequenos de continuidade e naturalidade, sem publicação remota.

A revisão Render e seus valores efetivos não foram identificados. **Aceitação
real continua pendente**, incluindo ASR, DAVE/rede, áudio ouvido, personalidade,
latência e custo. Nenhum push/deploy foi realizado. Baseline limpa: 632 testes
aprovados e 1 gate real ignorado; resultados finais, 15 cenários, métricas,
limitações, roteiro Discord e rollback estão no
[relatório V5.7](docs/V57_CONVERSATIONAL_RELIABILITY.md).

Gate local final: typecheck, lint, build, benchmark e `git diff --check` aprovados;
697 testes passaram em 36 arquivos, 1 gate real ignorado. Os 16 testes de
resistência cobrem os 15 cenários exigidos e falhas adicionais. Benchmark separa
entregas não confirmadas de sucesso; nenhuma redução de latência real é afirmada.
Commit de implementação: `798a9ad`.

Os números das revisões abaixo são históricos.

## Revisão V5.2: continuidade, turnos e personalidade

Escopo confirmado pelo operador: priorizar V5.2 em RAM e deixar V6/PostgreSQL
para o próximo ciclo. **Entrega técnica local preparada; aceitação em chamada
real pendente.** Não houve push, deploy, publicação de prompt, serviço pago ou
audição humana desta revisão.

As métricas informadas mostram áudio reproduzido e ausência de conclusão. O código
anterior reutilizava sessões somente após conclusão explícita; por isso sua
recuperação abria outros sockets e contava `agent_turns_superseded`. A V5.2 separa
essa recuperação em `agent_turns_recovered`, sem chamar geração incompleta de
resposta concluída. A fila também pode recuperar após áudio válido drenado sem
`agent_response`, evitando esperar o deadline de 45 s só pela ausência de texto.
Isso demonstra um bloqueio local, sem provar a origem do evento ausente no provedor
ou a causa de cada pico de produção.

O novo `RecentConversation` retém até dez interações consentidas por canal,
isoladas por Discord ID, canal, guild e versão do consentimento. Sessões novas
recebem contexto por `contextual_update`, limitado a 2.400 caracteres/4.096 bytes.
Respostas confirmadas e drenadas são distintas de `agent_text_observed`, texto
final observado sem prova de entrega integral. Este último serve somente como
referência do assunto, sem alegar que foi ouvido por completo. Falhas, correções
e truncamentos não viram respostas recordadas. Nenhum conteúdo entra nos logs.

TTL, revogação, saída, reset e `/jarvis context clear` limpam as entradas; o
comando cancela também o turno/fila próprios para impedir repovoamento tardio.
Sockets com contexto vencido são renovados antes da próxima pergunta, sem cortar
uma reprodução ativa. `/jarvis context status` é privado e não mostra conteúdo.
Uma confirmação de enfileiramento é permitida por turno; capturas distintas e
perguntas intencionalmente repetidas continuam independentes.

Upload mantém pacing e a fonte integral. Somente zeros digitais exatos já
existentes no final do PCM descontam o padding de 800 ms; silêncio adicional é
arredondado conservadoramente em frames de 20 ms. Ruído e voz baixa não contam
como zeros. O ganho real em microfone/Render continua por medir. Métricas novas
separam captura até playback, processamento após envio, sobreposição do upload
com geração e preparação do contexto. Timeouts sem áudio ficam separados da
recuperação por ausência de conclusão com áudio.

O prompt V3 original permanece intacto. Há um complemento aditivo para revisar
personalidade/contexto no ElevenLabs, sem override de prompt genérico nem nova
tool/variável dinâmica fictícia. A configuração remota e as respostas ouvidas
não foram certificadas pelos testes.

| Verificação V5.2 local | Resultado |
| --- | --- |
| Build, typecheck e lint Node | Passaram |
| Suíte Node | 30 arquivos; 507 testes passaram e 1 gate real skipped |
| Integrações de continuidade | Adapter, manager e memória reais; transporte/player controlados, sem comprovar fala humana |
| Suíte Python | 78 testes e 67 subtests passaram |
| Compileall e imports do AGENTS.md | Passaram sem conectar ao Discord |
| `git diff --check` | Passou |
| Elysium Python / Blueprint / dependências | Sem alterações |
| Variável opcional nova | `JARVIS_SHORT_MEMORY_TTL_SECONDS=600`; `0` desabilita, máximo 1800 |
| Deploy / audição / personalidade remota / latência antes-depois | Pendentes de autorização e validação real |

Guias: [operação e validação V5.2](docs/V52_PRODUCTION_VALIDATION.md),
[complemento de personalidade](docs/V52_PERSONALITY.md) e
[pesquisa do protocolo/SDK](docs/V52_PROTOCOL_RESEARCH.md).
Os números das revisões anteriores abaixo são históricos.

## Revisão V5: identidade, participantes, captura, ferramentas e latência

Entrega técnica local preparada. **A missão V5 permanece pendente de validação
real** com criador/convidado, perguntas escritas, roster vivo, pesquisa com fontes,
cinco perguntas sem duplicação e comparação de latência antes/depois.
Não houve deploy nem audição humana desta revisão. A confirmação do operador
refere-se à conexão, playback e ativação de voz anteriores.

Texto e voz recebem as quatro variáveis de identidade/contexto, com flags
sanitizadas por turno e atualização contextual em sessões reutilizadas. A nova
Client Tool `get_voice_participants` usa cache do canal e origem autenticada do
turno, sem retornar IDs/perfis nem tratar presença como consentimento de áudio.
Deduplicação por ID/janela de captura antecede STT e fila; perguntas novas de
conteúdo idêntico continuam aceitas. Rejeições distinguem fila global, individual
e memória. Não foi atribuída uma causa única às duplicações de produção.

Corrigida também uma corrida comprovada por teste: `client_tool_call` podia
ultrapassar ASR pendente atrás de um write assíncrono e receber recusa indevida.
Tools respeitam a ordem recebida sem bloquear áudio posterior; deadline, abort,
permissões e limites continuam aplicados. Pesquisa Brave ganha limite por worker,
fontes e estados de falha explícitos. `/status` mostra contadores e etapas de
latência completos em páginas; pacing de upload não foi alterado sem baseline.

`npm run audit:agent` consulta somente a configuração remota principal e tools
referenciadas, emitindo flags sem conteúdo privado. Não publica mudanças nem
comprova que o modelo segue o prompt. Neste ambiente, sua execução devolveu
`missing_configuration` e exit 1 esperado: credenciais ElevenLabs/Discord e chave
Brave não estavam disponíveis. Prompt publicado, contrato remoto e pesquisa real
precisam ser verificados no Render; nenhuma busca foi simulada como real.

| Verificação V5 local | Resultado |
| --- | --- |
| Build, typecheck e lint Node | Passaram |
| Suíte Node | 28 arquivos; 458 testes passaram e 1 gate real skipped |
| Suíte Python | 78 testes e 67 subtests passaram |
| Compileall e imports do AGENTS.md | Passaram, sem conectar ao Discord |
| `git diff --check` | Passou |
| Elysium Python / Blueprint / dependências | Sem alterações nesta revisão |
| Novas variáveis obrigatórias | Nenhuma; Brave usa `JARVIS_SEARCH_API_KEY` opcional já existente |
| Configuração remota / deploy / matriz real / latência antes-depois | Pendentes no ambiente do operador |

Deploy, variáveis e matriz de aceitação: [V5_DEPLOY_VALIDATION.md](docs/V5_DEPLOY_VALIDATION.md).
Prompt/tools: [V5_AGENT_PROMPT.md](docs/V5_AGENT_PROMPT.md).
Captura e avaliação do upload incremental: [VOICE_CAPTURE_LATENCY.md](docs/VOICE_CAPTURE_LATENCY.md).
Os resultados das revisões abaixo são históricos, sem certificar aceitação V5.

## Revisão: saudação inicial durante perguntas por voz

O operador confirmou conexão, playback ElevenLabs e entrada de voz, mas relatou
saudação repetida no lugar de resposta. O ponto `connectAgent()` do bot não
informava a supressão já implementada no adapter, permitindo a primeira mensagem
publicada em cada sessão nova. O worker passa a pedir primeira mensagem vazia por
padrão, com `JARVIS_SUPPRESS_FIRST_MESSAGE=true` e permissão restrita de override
First message na conta. Não há fallback automático que reabilite a saudação se o
provedor negar o ajuste. A alternativa explícita exige agente publicado com
First message vazio antes de definir a variável como `false`.

O reconhecimento do turno conversacional é observado por `user_transcript`
válido, sem registrar conteúdo. Captura, wake/follow-up, sessão aberta/reutilizada,
upload PCM, reconhecimento e geração têm sinais sanitizados correlacionados pelo
incidente local; saída anterior ao reconhecimento não vale como resposta à fala.
O áudio capturado completo continua enviado em frames com pacing e silêncio
final, mantendo ElevenAgents responsável por ASR, inteligência e voz.

A wake word não força nova conexão: sessões válidas do mesmo Discord ID são
reutilizadas. Recuperação V4 de turno sem conclusão pode abrir sessão nova para
isolar a próxima pergunta; não conserva contexto remoto automaticamente. Playback
progressivo, consentimento, limites, permissões e Elysium são preservados.

Validação de produção e configuração: [VOICE_GREETING_VALIDATION.md](docs/VOICE_GREETING_VALIDATION.md).
**Pendente: ouvir a resposta quatro a “Jarvis, quanto é dois mais dois?” em uma
chamada real, repetir perguntas consecutivas e testar dois participantes.** Não
houve deploy nem audição humana desta revisão. Os números V4 abaixo são histórico.

| Verificação da correção de saudação | Resultado |
| --- | --- |
| Build, typecheck e lint Node | Passaram |
| Suíte Node | 23 arquivos; 371 testes passaram e 1 gate real skipped |
| Suíte Python | 78 testes e 67 subtests passaram |
| Compileall e imports do AGENTS.md | Passaram, sem conectar ao Discord |
| Elysium Python e Blueprint Render | Sem alterações |
| Pergunta dois mais dois / sessão nova / consecutivas reais | Pendentes de deploy e audição humana |

As regressões incluem saudação durante conexão/upload, ASR final versus
tentativo/ausente/antigo, callbacks tardios, reutilização em cinco perguntas,
frames PCM e silêncio final em 8/16/24 kHz e interrupção inicial sem cortar a
fala. Resposta precoce também não aborta a captura já gravada. Os testes não
comprovam reconhecimento semântico ou resposta correta em uma call real.

## Revisão V4: fila e disponibilidade entre perguntas

O operador confirmou que o Jarvis já conecta no Render e que `/jarvis ask`
produz resposta audível na chamada real. O incidente atual é a aplicação manter
o turno ocupado após a fala porque falta `agent_response_complete`.

A revisão V4 separa fila de perguntas, sessão do provedor, drenagem local e
conclusão confirmada. Adiciona fila limitada por sala/Discord ID, prioridade do
proprietário entre perguntas aguardando e notificações de espera/cancelamento.
Uma nova pergunta pode retirar uma sessão sem conclusão após mensagem textual,
saída local drenada e nenhuma ferramenta conhecida pendente. Áudio já aceito
antes do corte drena; a sessão seguinte fica isolada. A geração anterior permanece
sem confirmação. Essa recuperação pode abandonar saída futura não sinalizada e
não conserva automaticamente o contexto remoto; não há memória de transcrições
compartilhada ou durável.

Voz mantém consentimento individual, wake/STT PT-BR experimental e follow-up na
sessão válida. Barge-in fica desabilitado por padrão; quando habilitado, exige
Discord ID do proprietário, aceite de áudio e comando explícito de parada.
Limites/cooldown e heurísticas locais reduzem eco, sem alegar AEC ou acurácia
comprovada. Nenhum detector acústico local substituiu STT sem benchmark.

Validação e deploy: [V4_CONVERSATION_VALIDATION.md](docs/V4_CONVERSATION_VALIDATION.md).
**O gate V4 permanece pendente: cinco perguntas consecutivas e ativação por voz
consentida precisam ser verificadas na chamada real.** A audição confirmada pelo
operador refere-se à versão de streaming anterior; esta revisão não executou
deploy nem audição humana.

| Verificação V4 | Resultado |
| --- | --- |
| Build, typecheck e lint Node | Passaram |
| Suíte Node | 22 arquivos; 337 testes passaram e 1 gate real explicitamente skipped |
| Suíte Python e preservação do Elysium | 78 testes e 67 subtests passaram; nenhum arquivo Python alterado |
| `git diff --check` | Passou |
| Deploy manual V4 / cinco perguntas / voz consentida | Pendentes de execução humana |
| Latência acústica PT-BR, falsos wakes, eco e custo | Sem medições V4; nenhuma promessa inferior a dois segundos |

## Histórico: revisão de reprodução progressiva

Evidência independente de produção confirmou áudio sem `agent_response_complete`:
30 eventos em 55 s; no Jarvis, `BABA0C1C` recebeu 79.360 bytes e reteve o áudio.
A revisão transmite PCM progressivamente para Opus/Discord com buffers limitados,
backpressure e cancelamento por consentimento. Conclusão da geração, fim de entrada,
drain local e término conversacional são estados separados. Recuperação sem evento
de conclusão preserva áudio válido e registra resultado não confirmado.

Pesquisa: [documentação e SDK oficial](docs/ELEVENLABS_STREAMING_RESEARCH.md).
Deploy e confirmação humana: [validação de produção](docs/STREAMING_PRODUCTION_VALIDATION.md).
**Nenhum deploy ou teste audível real foi executado nesta revisão.** A validação
final exige ouvir o Jarvis na chamada real; checks locais não aprovam esse gate.

Checks da revisão de streaming:

| Verificação | Resultado |
| --- | --- |
| Build, typecheck e lint Node | Passaram |
| `npm test` | 19 arquivos; 267 testes passaram e 1 gate real explicitamente skipped |
| `python -m pytest -q` | 78 testes e 67 subtests passaram |
| Compileall e imports do `AGENTS.md` | Passaram, sem conexão Discord |
| Elysium Python e Render Blueprint | Sem alterações nesta revisão |
| Deploy e audição real | Pendentes; nenhuma chamada real realizada nesta revisão |

Os testes novos cobrem SDK/protocolo, ordenação, cancelamento, ferramentas,
recuperação e limites. Um teste usa o player real do `@discordjs/voice` com Opus
sintético e rede simulada; isso verifica consumo local, sem provar audição humana.

## Histórico: revisão de diagnóstico de produção

Instrumentados `/jarvis join`, negociação de voz/DAVE e fluxo ElevenAgents até
playback. A revisão corrige a contagem de erro secundário no encerramento local,
detectou texto sem áudio/conclusão ausente/fechamento prematuro. Naquela revisão,
o playback aguardava conclusão explícita; essa política foi substituída pelo
streaming acima. Build, typecheck, lint e 230 testes Node passaram naquela entrega;
um gate real segue skipped. Python: 78 testes e 67 subtests passaram. Elysium não
foi alterado nesta revisão. Veja [o runbook Render](docs/RENDER_INCIDENTS.md).

O proprietário relatou Discord conectado e HTTP/WS ElevenLabs iniciados em
produção, mas nenhum áudio audível. A evidência posterior e o bloqueio local estão
registrados acima. A ausência de conclusão no provedor ainda precisa de investigação.

## Registro da entrega inicial

**Entrega técnica local implementada e verificada. Aceitação em chamada e produção
pendente.** Especificação: `../JARVIS_ELEVENAGENTS_CODEX_FULL_ACCESS.md`.

## Gates atuais

| Gate | Evidência e situação |
| --- | --- |
| A — build/lint/tipos/testes V5.2 | Passou localmente: 507 testes Node e gate real skipped; 78 testes Python e 67 subtests. |
| B — saída Discord/DAVE | Conexão e resposta audível confirmadas pelo operador antes da V4; entrada de humanos, transições e reconexões ainda exigem matriz própria. |
| C — ElevenAgents real | `/jarvis ask` audível confirmado pelo operador; origem da conclusão ausente permanece sem causa demonstrada. |
| D — comportamento V5.2 em chamada | Pendente: continuidade com sockets novos, pronomes, duas contas, resposta longa, pesquisa real, ausência de spam, personalidade e latência comparada. |
| E — Render V5.2 | Worker existente informado pelo operador; deploy desta revisão não autorizado nem executado. |

## Gates na entrega inicial

| Gate | Evidência e situação |
| --- | --- |
| A — instalação/build/lint/tipos/testes | Passou: 107 testes Node, 78 testes Python e 67 subtests. Um teste Node explicitamente skipped representa o gate real, não uma aprovação. |
| B — voz DAVE real | **Pendente:** sem token/IDs Discord e participantes. Spike: `npm run smoke:dave`. Opus/PCM/receiver/reconexão só comprovados com dados sintéticos. |
| C — ElevenAgents real | **Pendente:** sem agente/chave configurados. Assinatura/WS/áudio/tools têm testes de protocolo; nenhuma conversa real executada. |
| D — multiplayer/wake word real | **Pendente:** isolamento, consentimento, revogação e autorização testados localmente; pronúncia PT-BR, eco, WER, falsos wakes e latência não medidos. |
| E — produção Render | Blueprint validado pelo schema oficial; serviço Python preservado e integração opcional testada. **Nenhum deploy ou serviço pago criado.** |

## Implementado

- Worker independente em `jarvis/`, configuração isolada, dependências fixadas e lockfile.
- Slash commands `join`, `leave`, `status`, `privacy`, `consent`, `revoke`, `ask`, `tone` e `cancel` (V4).
- Consentimento por chamada, identidade Discord ID e privilégios do criador no backend.
- DAVE padrão, recepção por falante consentido, RMS/VAD, Opus, PCM e playback serializado.
- Sessões privadas ElevenAgents por usuário, formatos negociados, timeouts, TTL e limites.
- Entrada `/ask` escrita → ElevenAgents → voz, confirmada audível pelo operador na versão anterior à V4.
- V4: fila de perguntas limitada, isolamento, prioridade em espera, TTL e avisos de fila/cancelamento.
- V4: liberação por solicitação seguinte após drenagem, sem fabricar conclusão do provedor.
- V4: barge-in explícito do proprietário atrás de configuração e medições técnicas de etapas.
- Wake word experimental ElevenLabs Scribe, **desativado por padrão**; aceite adicional para envio pré-ativação e follow-up por falante.
- Client tool `search_game_info` com Brave Search opcional e limitação explícita sem chave.
- Integração opcional `JARVIS_BOT_USER_ID` no Elysium: acesso mínimo, slot e limpeza que preserva humanos/outros bots.
- CI Node separada, Blueprint aditivo, guias e System Prompt integral extraído do anexo.

## Verificações e resultados

| Comando | Resultado |
| --- | --- |
| `npm ci` | Passou; auditoria: 0 vulnerabilidades |
| `npm run build` | Passou |
| `npm run typecheck` | Passou |
| `npm run lint` | Passou |
| `npm test` | 14 arquivos, 107 passaram, 1 skipped explícito do gate real |
| `npm audit --omit=dev` | 0 vulnerabilidades |
| `python -m pytest -q` | 78 passaram e 67 subtests passaram; baseline 63 e 37 |
| `python -m compileall -q bot.py elysium` | Passou |
| Imports do `AGENTS.md` | Passaram, sem conectar ao Discord |
| `git diff --check` | Passou |
| Blueprint contra `https://render.com/schema/render.yaml.json` | Passou; serviço Python idêntico ao original |
| `npm start` sem credenciais | Código 1 esperado: só nomes de variáveis e erro sanitizado; nenhuma conexão iniciada |

Falhas locais iniciais: dependências Python ausentes foram instaladas; narrowing TS,
um lint de teste e whitespace foram corrigidos. Revisão também corrigiu cancelamento
de join pendente, completion residual, budget antes de abrir sessão, upload após
interrupção, áudio atrasado de sessão interrompida e respostas HTTP sem limite.
Não há falhas locais conhecidas. A CI foi preparada; não foi executada no GitHub.

## Limites reais e ambiente de teste

Na entrega inicial, as cinco variáveis estavam ausentes no ambiente local e em `jarvis/.env`:
`JARVIS_DISCORD_TOKEN`, `JARVIS_OWNER_USER_ID`, `JARVIS_GUILD_ID`,
`ELEVENLABS_AGENT_ID` e `ELEVENLABS_API_KEY`. Preencha só no ambiente privado;
não envie segredos em chat. As três variáveis Discord bastam para o spike DAVE.

Consulta em 21/10/2026: voice publicado 0.19.2, discord.js 14.27.0, Davey resolvido
0.1.12. A [issue #11653](https://github.com/discordjs/discord.js/issues/11653)
continua aberta e sem PR associado na página consultada. O código upstream ainda
contém a checagem de transition ID apontada no relato. Não houve reprodução aqui
por ausência de chamada real, patch especulativo, desativação de DAVE ou downgrade.
Davey carrega e cria/reset de sessão sintética funciona em Node24.19.0 Windows x64;
isso não comprova recepção de humanos. Veja a matriz [DAVE](docs/DAVE.md).

O detector experimental envia até 4 s de fala consentida por checagem ao STT externo,
inclusive antes da ativação; não é detector acústico local. Captura normal durante
playback é suprimida; V4 oferece exceção experimental restrita ao proprietário para
comando exato de parada, desabilitada por padrão. Entrada depende de fim de fala;
saída usa streaming progressivo e prioridade somente entre perguntas em espera.
Não há meta de latência comprovada.
Não há medições de WER, falsos wakes, p50/p95 ou custo/hora.

Sem banco/memória durável; sair/reiniciar exige novo consentimento. Retenção do
provedor depende da conta. Salas Elysium antigas precisam de revisão de overwrite
ou recriação normal; nenhuma migração remota foi feita. Manter uma única instância
e encerrar o processo anterior evita disputa durante implantação.

## Próximo ciclo operacional

1. Após autorização do operador, enviar o commit V5.2 revisado à branch do worker existente e fazer deploy manual,
   preservando uma instância e o Elysium Python. Conferir o SHA implantado.
2. Auditar o agente publicado, revisar o complemento de personalidade e executar
   o [gate V5.2](docs/V52_PRODUCTION_VALIDATION.md): continuidade, pronomes, duas
   contas, resposta longa, expiração/limpeza, fila, pesquisa real e latência
   comparada. Preservar a matriz V5 de identidade e V4 de barge-in opcional.
3. Executar matriz [DAVE](docs/DAVE.md): humanos antes/depois, RMS por usuário,
   `/jarvis tone`, transições MLS e reconexões; registrar versões/repetições reais.
4. Conferir o agente pelo [guia ElevenLabs](docs/ELEVENLABS.md), testar `/ask`,
   voz existente, eventos, pesquisa e revogação; depois wake com dois participantes.
5. Habilitar opcionalmente o [acesso às salas](docs/ELYSIUM_INTEGRATION.md), sem
   migrar ou modificar salas já existentes sem necessidade.
6. Repetir após restart/deploy e medir latência/custo sem conteúdo. Não sincronizar
   o Blueprint para criar outro worker.

O anexo foi preservado. Não foram criados banco, serviços pagos, deploys ou
mensagens a terceiros. O guia lista todas as configurações e comandos.
