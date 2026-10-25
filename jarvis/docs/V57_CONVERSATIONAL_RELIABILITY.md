# JARVIS V5.7 — Confiabilidade conversacional

## 1. Revisões auditadas e limite do diagnóstico

Revisão de 25/10/2026, iniciada em `main`, HEAD `9cdb6e1`. A implementação V5.6
`205270e` e sua documentação já estavam presentes. README, IMPLEMENTATION_STATUS,
V5.6 e o diff inicial foram lidos antes das novas alterações.

O checkout recebido já continha trabalho V5.7: 19 arquivos rastreados modificados,
este relatório em rascunho e `tests/conversation-endurance.test.ts` não rastreado.
Esse trabalho foi revisado e completado. O arquivo não rastreado e fora do escopo
`../JARVIS_V6_MEMORIA_CODEX.md` foi preservado e excluído dos commits desta entrega.
Dependências, lockfile, infraestrutura, voz e Elysium Python foram preservados.

**A revisão implantada no Render não foi identificada. Isso bloqueia atribuir os
incidentes reais a uma revisão ou afirmar equivalência de configuração.** Foi
solicitado ao operador o SHA e os ajustes não secretos. Não há logs recentes
correlacionados nem evidência de chamada real desta revisão.

O Blueprint rastreado contém voz `disabled`, captura de 12 s e seis verificações
wake/minuto. Ele não revela os ajustes do serviço existente. O campo validado
`RENDER_GIT_COMMIT` identifica o SHA do serviço/deploy, conforme a
[documentação Render](https://render.com/docs/environment-variables); o HEAD local
nunca é usado para preencher a revisão remota ausente.

## 2. Sintomas investigados

| Sintoma | Caminho investigado e evidência disponível |
| --- | --- |
| Para após 3–4 diálogos | Quota compartilhada gasta por falas sem wake; contexto de sessão ociosa perdido durante preparação; marca tardia de ferramenta; duração restante do socket em sequência longa. |
| Perguntas longas falham mais | Teto de captura, fim VAD, frames completos, conversão, pacing, total enviado, transcript final e TTL absoluto da sessão. |
| Fala parcialmente e anuncia erro | Erro causal emitido como terminal antes de drain; resultado parcial, conclusão remota e entrega local confundidos nos resumos. |
| Múltiplos participantes | Consentimento/ID/canal, streams separados, follow-up individual, revogação e prioridade sem cortar a resposta ativa de terceiro. |
| Standby exige outro join | Separação entre expiração ElevenAgents, receiver, player e transporte Discord; retorno após idle e perda transitória. |

Os limites wake, o teto de captura e o estado ocupado são fenômenos diferentes.
Rejeição esperada deve ter motivo observável; não é prova de deadlock.

## 3. Causas comprovadas em reprodução local

| Causa | Evidência e correção mínima |
| --- | --- |
| Prefixo enviado como pergunta completa | Em `9cdb6e1`, capturas contínuas de 12/15/20 s eram entregues ao atingir bytes/timer sem fim VAD. Agora são descartadas explicitamente antes de STT/agente, com aviso ao participante. |
| Terminal antecipado/duplicado | Erro recuperável podia emitir `jarvis_agent_turn_failed` antes de acabar a entrega e depois outro resultado. Erro causal agora usa `jarvis_agent_turn_error`; o terminal único sai após resolução de drain/recuperação. |
| Sessão antiga consumia solicitação nova | Fechamento/erro de socket ocioso durante `prepareSession` podia invalidar o pedido seguinte ou deixar sua fila sem dono. Remoção verifica identidade da entrada e da solicitação; há no máximo uma reaquisição antes de enviar entrada. |
| Ferramenta tardia contaminava reuso | Marcador de ferramenta após liberação podia ser herdado pelo próximo turno. Atividade em socket ocioso o retira; não concede autorização a uma ferramenta fora do turno ativo. |
| TTL interrompia pergunta longa válida | A sequência alternada reproduziu falha no 16º turno: restavam 9,4 s no socket e só 470 frames foram enviados. Antes de reusar, reserva-se tempo para upload conhecido, ASR e watchdog existentes; revalida-se após preparar contexto. Socket ocioso insuficiente é renovado. |
| Diagnóstico genérico apagava causa | Resumo `PLAYBACK_FAILED` substituía código/etapa específicos do encoder no detalhe do incidente. A evidência preserva a causa original, inclusive com incidentes intercalados. |

Nove regressões falharam contra a revisão limpa `9cdb6e1`: terminal
antecipado, perda durante preparação, ferramenta tardia e três durações que
entregavam prefixos; mais três verificações de admissão wake (janela móvel,
rejeição de quota antes da cópia PCM e pausa após duas ausências). As três últimas
demonstram proteção ausente, sem atribuir incidentes reais a essas políticas.
Elas passaram na revisão corrigida. A falha do 16º turno
apareceu ao tornar a resistência longa representativa; não foi inferida de uma
média de latência ou atribuída automaticamente aos incidentes de produção.

## 4. Hipóteses ainda não confirmadas

Não há evidência para afirmar uma causa única dos relatos após três ou quatro
diálogos. Faltam revisão Render, incidentes, ajustes do agente e teste real.
Falsos wakes acústicos, pausas PT-BR, interferência de microfone, DAVE/rede, quotas
da conta e workflows remotos continuam hipóteses, não diagnósticos concluídos.

Não se comprovou vazamento de Opus/PCM em produção, problema novo no Brave ou
necessidade de trocar dependências, aumentar timeouts ou acelerar PCM. Uma falha
isolada de receiver continua isolada ao stream; não reconstrói toda a chamada.
A presença de Kel não é evidência de falta de consentimento no turno do criador.

## 5. Relação entre repetição, perguntas longas e playback parcial

Falas de fundo consentidas podiam gastar as seis verificações wake antes de uma
pergunta legítima. Esse caso parece silêncio do bot, mas não ocupa a fila do
agente. Perguntas longas expunham outro defeito: recebiam corte local silencioso
e repetiam sua duração no upload com pacing. Turnos prolongados também aproximam
o socket do TTL de 300 s; um teste curto recriando o serviço não vê essa condição.

Uma falha posterior ao início da reprodução tem evidência de entrega diferente
de uma falha antes do primeiro pacote. O terminal antecipado escondia essa
distinção. São causas independentes que podem ocorrer na mesma conversa; não se
afirma que toda resposta parcial veio do teto de captura ou da quota wake.

## 6. Mudanças realizadas e invariantes

Foi corrigido o scheduler existente, mantendo `TurnRequest` e `Entry`. O pedido
carrega incidente/ID do turno, origem, contexto Discord autenticado, versão do
consentimento, canal e timestamps monotônicos. Flags existentes e eventos técnicos
descrevem upload, ASR, geração, ferramentas, streaming, reprodução e recuperação.
Não foi criada outra máquina de estados nem memória permanente paralela.

`terminalOutcome`, `terminalNotified` e `released` tornam explícitos os resultados
`completed`, `unconfirmed`, `failed`, `partial`, `cancelled` e `expired`. Pedidos
cancelados ou expirados em fila também têm terminal e liberação únicos. Callbacks
antigos verificam a entrada e o pedido atuais; não encerram um pedido novo.

| Evidência de entrega | Registro e consequência |
| --- | --- |
| Nenhum áudio aceito | `turn_delivery=none`; falha não vira memória entregue. |
| Áudio recebido sem primeiro pacote local | `not_started`; aviso específico sobre reprodução. |
| Primeiro pacote, saída interrompida | `partial`; terminal parcial quando falha, sem resposta completa na RAM. |
| Drain local sem confirmação remota | `unconfirmed`; não anuncia sucesso integral nem falha genérica só pela ausência de complete. |
| Conclusão remota e drain íntegro | `confirmed`/`completed`; elegível para contexto confirmado. |
| Evento de socket retirado | Ignorado para o turno novo; não abre outro terminal ou playback. |

Captura conserva o teto padrão de 12 s, incluindo o tempo necessário ao fim VAD.
Uma fala contínua de 12 s chega ao teto e é recusada; 12 s não são promessa de
12 s de fala mais silêncio adicional. O caminho configurável existente até 30 s
foi testado offline com 15/20 s, sem ampliar o padrão ou recomendar essa mudança
remota antes de medir reconhecimento/custo reais. PCM integral, downmix, frames de
20 ms, pacing e complemento de silêncio de 800 ms permanecem.

A admissão wake mantém o teto global em janela móvel de 60 s. Após duas falas
reconhecidas sem wake do mesmo ID/canal/consentimento, aplica pausa local de
10/20/40/60 s conforme novas ausências. Ativação válida reinicia essa sequência;
erro/cancelamento STT não conta como ausência. Há no máximo 16 registros, com
expiração preguiçosa, sem timers por participante. Revogar/sair limpa admissão,
mas nunca devolve chamadas gastas ao orçamento global.

Essa proteção reduz gasto por fala ambiente e também pode atrasar uma ativação
legítima durante a pausa. `/jarvis ask` continua disponível. Follow-up válido do
mesmo participante segue sua janela existente e dispensa outro STT wake; não
transfere consentimento, não remove o teto de turnos e não é sessão especulativa.

`/jarvis status` mostra transporte, receiver/player, fila, orçamento wake, pausas,
último sucesso confirmado e evidências deste processo. `detalhes:true` inclui
contadores/distribuições; `incidente:XXXXXXXX` consulta os últimos 64 incidentes.
Últimos 256 resultados e totais do processo têm denominadores identificados.

## 7. Arquivos alterados

- Scheduler e admissão: `src/agents/session-manager.ts`, `src/agents/wake-detector.ts`.
- Discord: `src/discord/{bot,commands,voice-receiver}.ts`.
- Evidência: `src/observability/{metrics,operational-evidence,status}.ts` e `scripts/analyze-latency.mjs`.
- Benchmark: `scripts/benchmark-pipeline.mjs` e `tests/benchmark.test.mjs` separam entrega local não confirmada de sucesso confirmado.
- Contrato de tom: `agent-system-prompt.md`; documentação: README, IMPLEMENTATION_STATUS, `docs/DAVE.md` e este relatório.
- Regressões: `tests/{agent-turn,bot-conversation,bot-v5,dave-smoke,latency-analysis,multiuser,observability,operational-evidence,playback-errors,status,voice-receiver,wake-detector}.test.*`.
- Resistência nova: `tests/conversation-endurance.test.ts`.

Não foram alterados arquivos Python, dependências, lockfile, `.env` ou Blueprint.
O histórico final dos commits é a referência exata dos arquivos entregues.

## 8. Baseline, testes anteriores e Gate A

As correções V5.6 de Ready/Signalling/Connecting, recuperação limitada, cooldown
Brave completo, Retry-After, causas de conexão e latência correlacionada já estavam
presentes. Foram preservadas e não apresentadas como novidades desta entrega.

| População verificada | Resultado |
| --- | --- |
| Revisão limpa `9cdb6e1` em checkout isolado | 632 testes passaram, 35 arquivos, 1 gate DAVE manual ignorado; typecheck/lint/build aprovados. |
| Trabalho V5.7 recebido, antes de completar | 672 passaram, 2 falharam, 1 ignorado. |
| Regressões contra V5.6 limpa, quatro arquivos | 9 falharam antes das correções/políticas; isso demonstra diferenças de comportamento locais. |
| Gate A final | **Aprovado:** typecheck, lint, npm test, build, benchmark e `git diff --check`; 697 testes passaram em 36 arquivos, 1 gate DAVE real ignorado. |

As duas falhas do trabalho recebido incluíam tratar substituição de socket como
cancelamento normal e uma assertiva de teste incompatível com o player global.
Esta última foi corrigida para conferir o recurso pertencente ao turno. Alterar
uma assertiva não foi contado como correção de produção.

Testes antigos isolavam bem protocolo e erros, porém muitos recriavam o harness
ou substituíam playback inteiro. A nova resistência usa adapter, manager,
receiver/VAD, STT adapter, PCM/Opus, fila e RAM reais. Rede, transporte Discord e
consumidor de pacotes são controlados; os testes específicos com AudioPlayer real
continuam complementares. Nenhum double comprova áudio ouvido ou ASR acústico.

## 9. Gate B — resistência sequencial

Cada linha abaixo mantém a mesma instância e seus recursos ao longo da sequência.

| # | Sequência e verificação |
| --- | --- |
| 1 | 20 perguntas escritas; um runtime, cada resposta liberada uma vez. |
| 2 | 20 capturas Opus com VAD, wake, upload com pacing e playback; follow-up evita STT repetido. |
| 3 | 10 perguntas curtas alternadas com 10 longas de 15/20 s no limite configurado de 30 s; fonte integral enviada e renovação segura do socket. |
| 4 | 10 respostas sem `agent_response_complete`; retiradas como não confirmadas, seguidas de pergunta normal. |
| 5 | Falha no quarto playback de 20 turnos e 16 respostas posteriores; caso adicional cobre start/player/encoder/Idle prematuro com recuperação. |
| 6 | Transcript final ausente no terceiro de oito turnos de voz; um erro, depois novas respostas. |
| 7 | Transporte transitório interrompe captura/upload/playback; Ready permite nova pergunta com consentimento preservado. |
| 8 | Criador e Kel alternam contexto; revogação de Kel cancela só seu trabalho. |
| 9 | Kel sem aceite não ganha subscription/STT; criador continua. Nome copiado não concede autoridade. |
| 10 | Três rodadas de streams simultâneos autorizados; IDs verificados e sinais sintéticos de 220/880 Hz distinguem origem e mistura. |
| 11 | Falas de 3/8/12/15/20 s no padrão de 12 s; duas aceitas e três descartes explícitos sem sessão adicional. |
| 12 | Brave sucesso, 429 e timeout com retorno estruturado, seguido de conversa normal; sem retries ocultos. |
| 13 | Três expirações ociosas do agente; Discord, receiver, consentimento e RAM permanecem válidos. |
| 14 | Ferramenta ociosa e áudio/texto/complete/error/close de sockets antigos durante turnos novos; sem contaminação ou terminal extra. |
| 15 | Três respostas de 20 s com backpressure, depois cancelamento e recuperação; buffers limitados e entrega não antecipada. |

Após cada checkpoint verificam-se fila, sessões abertas, streams destruídos,
PCM zerado, recursos antigos liberados, listeners limitados, timers esperados,
memória isolada, terminal único, liberação única e disponibilidade do próximo
turno. Teardown exige zero timers e listeners do serviço, fila vazia e nenhum
recurso de reprodução pendente. A retenção de sockets/recursos no harness serve
somente para verificar eventos tardios; não foi adicionada à produção.

**Gate B aprovado localmente:** os 16 testes de resistência passaram, cobrindo
os 15 cenários numerados e o caso adicional de quatro falhas distintas de
playback. O teste complementar com AudioPlayer real atravessou 20 respostas,
incluindo falha na quarta e erro do recurso antigo durante a quinta.
Esse gate aprova invariantes offline, não a experiência de uma chamada real.

## 10. Métricas antes/depois e desempenho

Reutilizados `Metrics`, os eventos por incidente e `scripts/analyze-latency.mjs`.
O relatório informa N, p50/p90/p95/máximo por etapa, populações pareadas, falhas,
cancelamentos, parciais, expirados e turnos sem terminal observado. Erro causal não
entra como terminal. Medida ausente permanece ausente; reuso/follow-up não
fabricam abertura/STT de zero milissegundos. Primeiro pacote local não é audição.

| Comparação controlada | Antes | Depois |
| --- | --- | --- |
| Captura contínua no teto de 12 s | Prefixo enviado como entrada normal. | Descarte explícito, sem nova chamada paga. |
| Falha recuperável após áudio | Evento terminal antes de resolver entrega; risco de segundo resultado. | Erro causal separado; um resultado final e uma liberação. |
| Upload no 16º turno longo reproduzido | 470 frames/9,4 s restantes antes de expirar. | Renovação ociosa antes de iniciar; teste exige fonte completa e próxima disponibilidade. |
| Duas falas sem wake + nova fala ambiente imediata | Terceira chamada consumia o teto compartilhado. | Pausa individual de 10 s, mantendo capacidade para outro participante. |
| Classificação no benchmark sem complete | Dez entregas locais rotuladas como dez sucessos. | Cinco confirmadas e cinco não confirmadas; nenhuma pergunta perdida. |

`npm run benchmark` passou em ambas as revisões. Mesma máquina Windows x64,
Node 24.19.0, Ryzen 7 7800X3D, fixtures e dependências; 25 amostras por caso e
cinco warmups. A tabela usa a execução final sequencial, sem typecheck/lint
concorrente. Valores em ms: **p50 / p90 / p95 / máximo**, N=25 em cada célula.

| CPU sintética | Antes (`9cdb6e1`) | Depois (`798a9ad`) |
| --- | --- | --- |
| Captura 48k estéreo → 16k mono, 1 s | 11,970 / 12,934 / 13,097 / 13,279 | 11,826 / 12,649 / 12,998 / 13,144 |
| Captura 48k estéreo → 16k mono, 3 s | 35,575 / 37,852 / 37,970 / 46,575 | 36,080 / 38,790 / 39,340 / 40,649 |
| Playback 16k → 48k, 20 ms | 0,434 / 0,482 / 0,490 / 0,501 | 0,420 / 0,442 / 0,460 / 0,479 |
| Playback 24k → 48k, 20 ms | 0,420 / 0,461 / 0,480 / 0,572 | 0,415 / 0,590 / 0,971 / 0,994 |
| Streaming 24k, primeiro frame | 0,180 / 0,202 / 0,207 / 0,214 | 0,193 / 0,296 / 0,306 / 0,357 |
| Streaming 24k, 1 s completo | 7,952 / 8,742 / 8,807 / 9,180 | 8,184 / 9,441 / 9,617 / 10,248 |

Alguns p95/máximos aumentaram; os algoritmos de CPU não foram alterados nesta
revisão. Esse ensaio de host não isola carga/scheduler a ponto de demonstrar
ganho ou regressão de CPU. Os valores não foram usados para justificar mudança
de pacing, VAD ou timeouts, nem para prometer melhora acústica.

O pipeline virtual dos 11 modos manteve **todas as distribuições por etapa
idênticas** às da baseline. Exemplos abaixo usam tempo virtual desde captura/
submissão até o primeiro pacote local, em ms, antes=depois. São hipóteses de
protocolo controladas, sem medir rede ou audição.

| Cenário virtual | N de interações | p50 / p90 / p95 / máximo | Confirmadas / não confirmadas / sem entrega |
| --- | --- | --- | --- |
| Voz curta | 5 | 5686 / 5686 / 5686 / 5686 | 5 / 0 / 0 |
| Voz longa da fixture | 5 | 11686 / 11686 / 11686 / 11686 | 5 / 0 / 0 |
| Texto | 5 | 1526 / 1526 / 1526 / 1526 | 5 / 0 / 0 |
| Consecutivas | 10 | 2196 / 2866 / 2866 / 2866 | 10 / 0 / 0 |
| Dois falantes | 10 | 2439 / 3352 / 3352 / 3352 | 10 / 0 / 0 |
| Conclusão ausente | 10 | 1526 / 1526 / 1526 / 1526 | 5 / 5 / 0 |
| ASR ausente | 5 | Sem amostras de primeiro pacote | 0 / 0 / 5 timeouts |
| STT falha | 5 | Sem amostras de primeiro pacote | 0 / 0 / 5 rejeitadas |
| Busca controlada normal | 5 | 1676 / 1676 / 1676 / 1676 | 5 / 0 / 0 |
| Busca controlada timeout | 5 | 6526 / 6526 / 6526 / 6526 | 5 / 0 / 0 |

O benchmark rotulava `onTurnDelivered` como sucesso, mesmo quando a geração
era `unconfirmed`. A correção separa `success`/`success_rate` (somente confirmadas),
`local_deliveries` e `unconfirmed_deliveries`/`unconfirmed_delivery_rate`; a conta
de perguntas perdidas continua excluindo ambos os tipos de entrega. No cenário
sem complete, a taxa confirmada é 50%, não os 100% aparentes da baseline.
Isso corrige a interpretação do relatório e não representa piora de entrega.
Drain→liberação nesse cenário continua p50=1987, p90/p95/máximo=3974 ms, N=10;
não foi artificialmente zerado para aparentar fluidez.

Médias históricas do operador: captura+VAD 2859,6 ms; fim de fala 746,9 ms;
wake STT 686,1 ms; fila 5173,5 ms; abertura 535 ms; upload 4491,4 ms;
pós-upload→áudio 365,8 ms; drain→disponibilidade 7532,6 ms. São populações de
revisões desconhecidas, não um baseline pareado. Não somá-las nem comparar
diretamente ao indicador de 1,02 s do painel ElevenLabs.

**Nenhuma redução de latência real foi comprovada.** O benchmark CPU existente
usa áudio sintético e não mede rede, reconhecimento, voz audível ou créditos.
Para comparar produção, separar exports por SHA/processo e parear duração,
origem, carga/fila, participante e configuração, incluindo falhas. Executar:
`Get-Content -LiteralPath 'C:\caminho\logs-sanitizados.jsonl' | node scripts/analyze-latency.mjs`.

## 11. Render: alterações necessárias e conferência

Nenhuma variável obrigatória nova, mudança de plano ou serviço adicional.
Preservar uma instância do worker e confirmar término da anterior. Não sincronizar
Blueprint para criar outro serviço. Capturar SHA real, modo de entrada e valores
não secretos de `JARVIS_MAX_AUDIO_SECONDS_PER_TURN`,
`JARVIS_MAX_WAKE_CHECKS_PER_MINUTE`, `JARVIS_FOLLOWUP_SECONDS`,
`JARVIS_MAX_SESSION_SECONDS` e `JARVIS_SESSION_IDLE_SECONDS` no serviço existente.

O valor rastreado `JARVIS_VOICE_INPUT=disabled` não deve substituir às cegas uma
configuração operacional consentida. Sem os valores efetivos, divergência
local/Render permanece bloqueio de diagnóstico. Não copiar ambiente completo,
tokens, IDs pessoais ou URLs assinadas para logs/chat/commits.

## 12. ElevenLabs e personalidade local

`npm run audit:agent` foi executado após build: retornou `missing_configuration`,
`configuration_checks_passed=false`, `runtime_behavior_verified=false`, exit 1.
Não houve consulta autenticada ou comparação efetiva do agente publicado; esse
resultado esperado não aprova configuração remota nem o Gate C.
O `audit:agent` existente compara prompt/configuração em RAM e declara
`main_agent_only`; workflows ainda precisam de revisão manual. Ausência de
configuração ou divergência não autoriza publicar ajustes automaticamente.

Revisar `user_transcript`, áudio, respostas, conclusão e eventos de ferramentas;
First message vazio/override restrito conforme configuração existente; formatos
PCM e turn-taking publicados. A documentação oficial define transcript final e
conclusão da resposta incluindo ferramentas, habilitada explicitamente em
[client events ElevenLabs](https://elevenlabs.io/docs/eleven-agents/customization/events/client-events).
O worker inicia playback progressivo sem esperar complete, mas drain sozinho
nunca fabrica conclusão do provedor. Ausência do evento pode ser recuperável.

O prompt local recebeu apenas dois ajustes: continuidade direta/seriedade durante
o problema atual e erro de pesquisa explicado naturalmente, respeitando cooldown.
PT-BR, humor seco ocasional, cordialidade, afeto com Kel, Discord ID como autoridade
e uso de contexto real já existiam. Não foi publicado prompt remoto, workflow ou
perfil factual; a [proposta V5.6](V56_CREATOR_PROFILE_PROPOSAL.md) continua separada.

| Situação de avaliação | Critério perceptivo, sem resposta decorada |
| --- | --- |
| Plano arriscado no jogo | Orientação útil; discordância respeitosa; ironia ocasional sem humilhação. |
| Derrota repetida | Humor proporcional e ajuda concreta, sem inventar histórico. |
| Pedido técnico “sem piada” + follow-up | Resposta direta; preferência séria mantida no problema. |
| Mensagem amorosa para Kel | Sinceridade; humor só se melhorar a mensagem. |
| Convidado pergunta ou diz ser criador | Cordialidade e utilidade; nenhuma autoridade por declaração/nome. |
| Contexto ausente/ambíguo | Uma pergunta relevante; nenhuma memória inventada. |
| Brave indisponível/cooldown | Admite limitação, sem fontes inventadas ou repetição imediata. |
| Dez turnos seguidos | Sem saudação/confirmação formal/pergunta de encerramento repetitiva. |

Registrar 0/1/2 para utilidade, naturalidade, continuidade e adequação do humor,
com cenário e revisão; a soma não substitui avaliação humana ou segurança.

## 13. Gate C — roteiro após implantação autorizada

1. Registrar SHA Render, configuração não secreta, `/jarvis status` inicial e
   orçamento. Executar auditoria somente leitura no ambiente autorizado; revisar
   workflows. Aceites são individuais e a resposta será audível à sala.
2. Criador usa `/jarvis join`; executar `/jarvis tone` três vezes. Confirmar som
   humano e retorno a Idle. Tom não usa ElevenLabs e separa transporte de agente.
3. Após `/jarvis consent`, executar cinco `/jarvis ask` consecutivos; conferir
   incidentes, resposta audível, terminal correto, fila liberada e próxima entrada.
4. Criador aceita áudio explicitamente. Fazer ao menos dez turnos de voz, com
   follow-up, pausas naturais e perguntas curtas/longas. No padrão, 3/8 s devem
   caber; 12/15/20 s contínuos devem ter descarte explícito. Avaliar limite maior
   somente por decisão/configuração deliberada e orçamento, sem gravar pessoas.
5. Respeitar seis wakes por janela móvel de 60 s: fora do follow-up, espaçar
   ativações por pelo menos 11 s e conferir saldo. Falas ambiente consentidas e
   barge-in também gastam esse teto. Respeitar pausas individuais de 10–60 s;
   usar `/ask` para distinguir admissão esperada de travamento.
6. Kel entra sem consentir: sua voz não gera processamento; criador continua.
   Depois ambos aceitam áudio e alternam perguntas/contextos distintos. Testar
   sobreposição e revogar Kel durante seu turno sem cortar o criador.
7. Fazer uma pesquisa Brave útil, conferir fontes/limitação e liberar próxima
   pergunta. Não provocar 429 para testar quota; usar falhas controladas locais.
8. Esperar além do idle de 45 s e do lifetime de 300 s, com humanos presentes;
   confirmar Jarvis no Discord e nova pergunta operacional. Em manutenção,
   interrupção transitória durante tom deve recuperar uma vez, sem áudio antigo.
   Saída explícita/restart/destruição da sala exigem o ciclo de autorização previsto.
9. Aplicar a matriz perceptiva e comparar latência/taxa de falha por SHA, com N e
   percentis. Registrar incidentes sanitizados; primeiro pacote não prova audição.
10. Após o smoke de dez turnos, validar sessões de 20 ou mais interações com
    custos controlados. Falha inexplicada, mistura de identidade ou resposta
    parcial contada como completa impede aprovação. Este gate permanece pendente.

## 14. Commits e rollback

Implementação local: **`798a9ad`**, `fix(jarvis): stabilize consecutive conversational turns`.
Este relatório, README, IMPLEMENTATION_STATUS e guia DAVE estão no commit
documental seguinte; `git log -2 --oneline` identifica ambos sem autorreferência
de hash no próprio documento.
Commits locais somente após Gate A/B aprovados. Nenhum push ou deploy executado.

Se uma implantação futura autorizada falhar, selecionar manualmente o último SHA
operacional conhecido do serviço. `9cdb6e1` é a base local V5.6 desta revisão,
não uma declaração de que ela estava implantada ou corrigia os relatos. Para
reverter V5.7 em Git, usar `git revert 798a9ad` numa
nova revisão revisada, sem reset destrutivo, push/deploy automático ou alteração
de segredos/plano/voz. Reinício exige consentimento novo. Prompt remoto não foi
modificado e não demanda rollback desta entrega.

## 15. Limitações e recomendação de implantação

Gates A/B verdes permitem recomendar **avaliação em implantação controlada**,
desde que o operador identifique revisão/configuração atuais, revise os commits
e autorize push/deploy separadamente. Não significam aprovação de produção.
Gate C exige evidência humana real. SHA remoto desconhecido, configuração não
auditada e ausência de métricas pareadas continuam explícitos.

A renovação ociosa reduz expiração previsível durante a entrada; o TTL absoluto
continua podendo encerrar uma resposta excepcionalmente longa. O padrão de 12 s
recusa capturas sem fim VAD antes do teto. Qualidade de pausas/ASR, falsos wakes,
eco, backoff legítimo, DAVE/rede, naturalidade, custos e latência reais precisam
ser medidos. A memória usa apenas confirmação e entrega local disponíveis;
jamais garante que uma pessoa ouviu todos os pacotes.

## 16. Segurança, custos e controles preservados

Discord User ID continua autoridade; consentimento individual e revogação cercam
captura, STT, fila, agente e tools. Follow-up fica no ID/canal/versão; presença,
nome ou pedido falado não concedem administração. Sessões encerradas não encerram
Discord por inatividade. Recuperação não reproduz entrada antiga nem compra
chamadas especulativas. Não há banco, perfil pessoal ou memória permanente nova.

Logs passam por allowlist de enums/booleanos/números e incidentes de oito hex
maiúsculos. Não armazenam áudio, transcrições, consultas, participantes, prompt,
tokens ou URLs assinadas. Detalhes preservam causa/etapa; contadores indicam seu
escopo temporal. O diagnóstico DAVE usa ordem do falante e últimos quatro dígitos
mascarados, apenas na resposta privada do criador; não imprime IDs completos.

Brave V5.6 foi preservado: uma chamada em voo, intervalo entre inícios, deadline
total padrão de 5 s, abort, cooldown completo e `finally` liberando o slot. IDs
de tool calls são deduplicados e limitados; não há cache sem evidência de consultas
duplicadas. Os resets de múltiplas janelas são em segundos, conforme
[Brave rate limiting](https://api-dashboard.search.brave.com/documentation/guides/rate-limiting).
Falha de pesquisa retorna estado estruturado e não inutiliza turnos seguintes.

Nenhuma chamada paga de conversa, nova integração, alteração remota, serviço pago,
troca de voz/plano, aumento de teto global ou contorno de quota foi realizado.
Fixtures são sintéticas; dados pessoais não foram usados para facilitar testes.
