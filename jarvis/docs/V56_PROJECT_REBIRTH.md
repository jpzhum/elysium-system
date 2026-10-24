# JARVIS V5.6 — Project Rebirth

## Resumo executivo

Foram corrigidas causas locais reproduzíveis de admissão de áudio durante
reconexão, retries antecipados de provedores e perda de diagnóstico. Recepção,
fila, playback e disponibilidade agora acompanham todos os estados de transporte.
Consentimento, identidade, voz, prompts remotos e Elysium Python preservados.
Os incidentes históricos não são declarados resolvidos: falta validação audível
da revisão no Discord e comparação com o agente publicado.

Auditoria iniciada em 24/10/2026. Base local: `main`, `cfcdd03`. A única
alteração preexistente era `JARVIS_V6_MEMORIA_CODEX.md`, não rastreada e preservada.
Node 24.19.0, npm 11.17.0; dependências instaladas iguais ao lockfile:
discord.js 14.27.0, @discordjs/voice 0.19.2, opusscript 0.1.1, ws 8.22.0.
O Blueprint prepara o worker `rootDir: jarvis`, uma instância e deploy manual.
Isso não comprova a revisão executada no Render. Não há logs de produção ou
call Discord acessíveis neste ambiente. Configuração local suficiente para
`audit:agent` está ausente; o comando autenticado não foi executado.

## Mapa do pipeline antes de alterações

| Transição | Entrada → saída e sucesso | Dependências / prazo | Falhas, recursos, concorrência e cancelamento | Custo externo |
| --- | --- | --- | --- | --- |
| Discord → DAVE/Receiver | VoiceConnection Ready + speaking.start de ID consentido → Opus por ID | UDP, DAVE negociado, @discordjs/voice; join 20 s, recuperação 25 s/max 3 tentativas | Erro parse/decrypt destrói só stream; receiver suspende em todo estado diferente de Ready; revoke/stop liberam stream, decoder e timers; eventos tardios validam identidade da captura | Nenhum |
| Receiver → VAD | Opus → PCM16 48 kHz estéreo alinhado 4 bytes; RMS ≥ 0, 008 | OpusDecoder; silêncio 600 ms, teto 12 s | Streams isolados; descarta silêncio inicial; limpa chunks; fim por VAD/stream/teto; onTurn retém PCM até Promise encerrar e zera depois | Nenhum |
| VAD → Wake STT | Captura válida inteira → ativação/follow-up autorizado por ID | Scribe, até 4 s de trecho; deadline 8 s; fila 2 e limite/min | Aborto por revoke/reconnect; dedupe por captura, não hash/conteúdo; cópias apagadas; outros sem consentimento nunca são subscritos | STT de cada verificação consentida, mesmo antes de dizer wake |
| Wake → fila | ID/consentVersion atuais → request serial da sala | Até 8 aguardando, 2/usuário,TTL 60 s,budget 120/h | PCM pendente limitado 16 MiB; revogação/saída cancela só usuário; prioridade do criador apenas entre aguardando; prazo remove e libera buffer | Nenhum até dispatch |
| Fila → ElevenAgents | Signed URL → WS → metadata PCM e sessão por falante | Signed URL 10 s/tentativa, até 3 em 429/5xx; handshake 10 s; metadata 15 s; lifetime 300 s | Abort fecha WS/timers; contexto e consentimento revalidados; sem prompt/tools override; metadata/greeting não comprovam reconhecimento | Abertura do agente; retries somente obtenção URL, sem replay de fala |
| PCM → reconhecimento | Captura inteira → mono na taxa negociada → chunks 20 ms + silêncio final 0, 8 s | Conversão sinc; pacing 20 ms; watchdog ASR 10 s começa após upload completo | Cauda desconta zeros existentes; upload não trunca em resposta precoce; user_transcript final desbloqueia saída; tentative/greeting não contam; abort apaga PCM; sem retry cego | Processamento ElevenAgents |
| Reconhecimento → resposta/ferramentas | user_transcript → texto/PCM/eventos de ferramenta | Progresso 45 s; ferramenta 8 s incluindo fila | Tools somente turno/consentimento ativo; duplicatas por tool_call_id bloqueadas; erro Brave retorna resultado estruturado; callback e writes com backpressure | ElevenAgents e busca opcional |
| Brave | Parâmetros exatos/autorizados → trechos/fontes limitados | Uma chamada ativa, inícios ≥ 1 s; deadline configurável 5000 ms inclui headers/body | Aborto libera slot/reader; corpo ≤ 256 KiB; cooldown de quota/429; sem retries, sem abrir páginas; revalidação após await | Uma consulta externa quando admitida |
| PCM remoto → Opus | PCM16 mono → resampling contínuo 48 kHz estéreo → frames 960 samples/20 ms | StreamingPcm + OpusScript; 384 KiB/120 s por resposta | Backpressure acorda no cancel; alinhamento contínuo e padding somente EOF; codec liberado em finally; erro de encoder preservado | Nenhum |
| Opus → AudioPlayer → Discord | AudioResource Opus → Playing → EOF+Idle | Fila 4; prazo absoluto 180 s inclui espera; conexão Ready e assinatura atual | Erro cancela recurso sem replay; microtask impede erro antigo de atingir próximo; drain 250 ms é observação local, sem provar geração/audição; stop/revoke encerram recursos | Nenhum |
| Conclusão → memória/liberação | Complete explícito + playback terminado → resposta confirmada; sem complete → recuperação rotulada | Próxima pergunta ou watchdog 45 s; idle 45 s; follow-up 18 s | Falta complete não fabrica confirmação; transporte antigo drena e fecha; contexto por ID/consentVersion, RAM 10 turnos/TTL 600 s/2400 caracteres; fim da sessão não desconecta Discord | Nova sessão futura apenas quando necessário |

## Classificação inicial e hipóteses

- **CONFIRMADO:** playback só cercava Disconnected/Destroyed, embora a biblioteca
  instalada faça Ready→Signalling→Connecting em rejoin. Receiver já suspendia;
  playback e admissão da fila precisavam acompanhar o mesmo estado real.
- **CONFIRMADO:** cooldown Brave truncava resets longos em 120 s. Quota conhecida
  continuava esgotada quando o worker voltava a permitir solicitações.
- **CONFIRMADO:** faltava correlação fim da fala→primeiro pacote local e status
  distinguindo última falha/recuperação/revisão/janela de resultados.
- **CONFIRMADO:** algumas causas tipadas do connector eram resumidas como
  AGENT_PROVIDER_ERROR; diagnóstico insuficiente, sem provar defeito remoto.
- **NÃO REPRODUZIDO:** incidente D51204EF com 33884 bytes; regressão existente
  gera 53 pacotes Opus válidos. A exceção original não está disponível.
- **NÃO REPRODUZIDO:** causa única dos 29 reconhecimentos ausentes e dos 73 erros
  de receiver. São contadores acumulados de revisões não identificadas.
- **PROVÁVEL:** upload com pacing reexecuta a duração da fala e contribui para
  latência. Não é justificativa para acelerar/remover silêncio sem teste real.
- **DEPENDE DE TESTE REAL:** DAVE/rede, VAD e ASR PT-BR, som audível, sessões
  ociosas, reuso, personalidade publicada e workflows/first message do agente.

## Verificação inicial

Antes de alterações: typecheck, lint, build aprovados; 603 testes passaram em 34
arquivos, 1 teste manual DAVE ignorado. Nenhuma chamada paga, push ou deploy.
O prompt local já contém estilo, afeto, seriedade, identidade por ID e memória
incompleta; correspondência com publicado permanece desconhecida.

## Causas demonstradas e correções

| Hipótese verificável | Evidência antes | Alteração e verificação depois |
| --- | --- | --- |
| Rejoin sem Disconnected admite resposta sem transporte pronto | Duas regressões de playback com AudioPlayer real ficaram em Buffering; duas regressões bot/session-manager mantiveram sessão aberta em Signalling/Connecting | Todos os estados diferentes de Ready suspendem admissão, cancelam recursos uma vez e fecham somente sessões do provedor; Ready permite próxima pergunta. Mesma conexão/player e consentimentos preservados; resposta antiga não é reenviada. |
| Brave volta a chamar antes do reset conhecido | Duas regressões fizeram fetch adicional após 120 s, antes do reset mensal/data HTTP | Cooldown guarda timestamp completo, sem timer/retry; Retry-After aceita segundos/data. Mantido 5000 ms para cada execução externa. |
| Signed URL ignora Retry-After longo | Quatro regressões fizeram retry prematuro em 429/503/HTTP-date | Dentro do teto existente 2 s, espera o prazo indicado; além dele falha imediatamente sem nova chamada. Permanecem no máximo 3 tentativas de URL, nunca replay de áudio. |
| Causa do connector desaparece no resumo | Request timeout/close antes de metadata apareciam como AGENT_PROVIDER_ERROR | Códigos distintos para timeout de URL, falha de envio, abertura, entrada inválida e fechamento prematuro; classificação sanitizada sem texto upstream. |
| Falta fim da fala e resultado dos cancelamentos na análise | Regressões não encontraram métrica nem evento terminal | Receiver fornece timestamp monotônico do último PCM com voz; uma amostra speech_end_to_first_packet por turno. Cancelamentos aceitos emitem resultado idempotente, inclusive fila, sem reter PCM. |
| Status não distingue evidência, contadores antigos e resultados recentes | Status mostrava sockets/contadores, sem última causa, recuperação ou revisão | Observador recebe apenas campos sanitizados/congelados; últimos 256 resultados separados do total do processo; confirmação exige complete+drain, não soma de contadores independentes. Hash Render validado e ausência explícita. |

O total de CPU Opus por recurso é emitido uma única vez, incluindo tentativas
que falham; recursos cancelados antes de codificar não inventam amostra zero.
A métrica existente por frame continua independente. O erro do player/codec
continua separado do evento de medição e do resumo do turno.

Não houve evidência para reconstruir a chamada por um erro isolado de receiver,
alterar negociação DAVE, acelerar o upload, aumentar timeouts ou forçar reuso.
O cancelamento de uma resposta após perda de transporte não a reproduz de novo;
o operador pode fazer outra pergunta depois da recuperação.

## Contrato ElevenLabs e personalidade

- ElevenAgents continua responsável por reconhecimento conversacional, raciocínio
  e TTS. Wake continua usando ElevenLabs STT. Voz personalizada inalterada.
- PCM mono na taxa negociada, `user_audio_chunk` no envelope oficial, pacing 20 ms,
  captura completa e silêncio final 0, 8 s preservados. Um greeting não substitui
  `user_transcript` final; reconhecimento tem deadline próprio 10 s após upload.
- `agent_response_complete` precisa estar habilitado nos client events e continua
  sendo o único sinal explícito de conclusão da geração. Drain local e silêncio
  não fabricam esse evento. Recuperação sem ele permanece `unconfirmed`.
- Override somente de First message conforme configuração existente; sem prompt
  ou tool override. Não houve edição do agente publicado, workflow ou assinatura.
- `audit:agent` não executado: configuração adequada ausente. Não se sabe se o
  prompt publicado equivale ao local, nem se workflows introduzem conflitos.
  O operador deve fazer a auditoria somente leitura no ambiente autorizado e
  revisar manualmente os nós do workflow; a auditoria declara `main_agent_only`.
- O prompt local já exige PT-BR, humor contextual sem humilhação, acolhimento de
  Kel/convidados, pedidos românticos sinceros, seriedade quando solicitada e
  autoridade exclusivamente por Discord ID. Foi preservado; variações de tom
  ainda precisam de avaliação perceptiva, sem respostas decoradas.
- Memória curta continua por participante/consentimento, sem banco; texto de
  resposta incompleta não vira resposta integral entregue. Perfil factual fica
  na [proposta separada](V56_CREATOR_PROFILE_PROPOSAL.md), com campos vazios e
  aprovação pendente. Nenhuma biografia nova foi publicada ou enviada ao agente.

## Configuração e identificação da implantação

Nenhum timeout, limiar VAD, tamanho de fila, pacing, permissão, intent ou
dependência mudou. `RENDER_GIT_COMMIT` é metadado opcional, já fornecido pelo
Render; leitura/validação centralizadas em `jarvis/src/config.ts`. Aceita somente
hash hexadecimal7–40 caracteres; ausente aparece como “não informada”. A revisão
do checkout local nunca é atribuída ao worker remoto. `.env.example` apenas
documenta esse campo automático. Nenhum `.env` foi adicionado ao Git.

`/jarvis status` separa Gateway, VoiceConnection, receiver, assinatura/player/
DAVE local, sockets ElevenAgents, turno ativo/fila, última evidência de ASR/
ferramenta, última falha e recuperação. A indicação disponível do playback é uma
verificação local, não prova acústica. Resultados usam requests encerrados como
denominador, incluindo cancelamentos na fila; não representam taxa de sucesso
de reconhecimento, créditos ou audição. Percentis mantêm até 256 amostras por etapa;
contadores e máximos agregados são desde o início deste processo.

## Métricas de latência e limites da comparação

As médias históricas fornecidas pelo operador são referência, não um baseline
controlado desta versão: captura+VAD2859, 6 ms; fim da fala 746, 9 ms; STT 686, 1 ms;
fila 5173, 5 ms; abertura 535 ms; upload 4491, 4 ms; pós-upload→áudio365, 8 ms no subconjunto
disponível; captura→pacote local 14158, 5 ms; drain→disponibilidade 7532, 6 ms. As
populações e revisões não foram comprovadas. Não somar essas médias, comparar
diretamente com 1, 02 s do painel ou calcular p50/p95 a partir delas.

| Etapa solicitada | Medição efetivamente disponível |
| --- | --- |
| speech_end_to_first_audible_ms | `speech_end_to_first_packet_ms`: último PCM com voz→primeiro pacote consumido pelo player; audição exige medição externa/manual |
| wake_stt_ms | `wake_recognition_ms`/`wake_stt_request_ms` agregados existentes; `wake_detection_ms` correlacionado inclui fila/preparação/STT |
| queue_wait_ms | `question_queue_wait_ms` agregado e `question_wait_ms` por incidente |
| agent_connect_ms | `agent_session_open_ms` agregado e `agent_connect_ms` por incidente; reuso não inventa duração zero |
| audio_upload_ms | `agent_audio_upload_ms` agregado e `upload_ms` por incidente |
| remote_first_audio_ms | `agent_remote_first_audio_ms` agregado e `remote_first_audio_ms` por incidente; áudio antes do fim do upload fica explicitamente sem esse delta |
| opus_encode_ms | CPU por frame no agregado existente e subtotal por recurso/incidente no evento de playback |
| playback_start_ms | Primeiro áudio→primeiro pacote local; inclui conversão/buffer/encode, não apenas Playing |
| turn_release_ms | `next_question_ready_ms` drain→liberação; `agent_turn_logical_end_ms` início→fim lógico preservado; evento release correlacionado |

O extrator offline aceita os novos eventos/campos, mantém populações pareadas
por incidente, informa N/p50/p90/p95/máximo e separa cancelamentos sem início de
turnos iniciados. Falta de medida permanece ausência, inclusive em follow-up,
reuso e áudio precoce. As taxas indicam o denominador e não excluem falhas para
produzir um número melhor.

**Não há nova medição de latência real nem melhora percentual comprovada nesta
entrega. A meta experimental de p50 próximo de 3 s após a fala não foi validada.**
Os testes de relógio injetado validam cálculo e correlação, não velocidade de
rede. Não há justificativa para mudar captura/ASR com base neles.

## Matriz de aceitação automatizada e real

U = unidade offline; I = integração simulada, com SessionManager/player reais
quando pertinente e transportes/provedores controlados. Esses doubles são de
teste; nenhum sistema de produção foi substituído. R = validação real pendente.

| # | Cenário | Cobertura offline | Gate real |
| --- | --- | --- | --- |
|1| Criador sozinho | I bot-v5, voice-recognition | R voz audível |
|2| Criador + Kel sem consentimento | I bot-v5; U voice-receiver | R somente stream do criador |
|3| Ambos autorizados | I multiuser, bot-v5 | R atribuição correta |
|4| Entrada/saída durante resposta | I bot-v5, bot-lifecycle | R não cortar terceiro |
|5| Falas sobrepostas | U voice-receiver; I multiuser | R microfones reais |
|6| Fim VAD | U voice-receiver, capture-window | R pausas/PT-BR |
|7| Áudio inválido/silencioso | U voice-recognition, pcm-conversion | R microfone e ruído |
|8| Sem wake | U wake-detector; I voice-recognition | R falsos positivos/negativos |
|9| Follow-up legítimo | I multiuser, voice-recognition | R referência arma/missão |
|10| Follow-up indevido | I multiuser; U consent | R outra pessoa/janela vencida |
|11| Sem user_transcript | I voice-recognition, elevenlabs-client | R eventos publicados |
|12| Sem response_complete | I agent-turn, multiuser | R retorno da fila sem dupla fala |
|13| Falha abertura | U elevenlabs-client; I agent-turn | R somente se ocorrer, sem provocar gasto |
|14| Falha envio PCM | I agent-turn, voice-recognition | R causa técnica se ocorrer |
|15| Falha encoder | I playback-errors com erro injetado | R tom após recuperação |
|16| Erro AudioPlayer | I playback-errors com player real | R audição/diagnóstico |
|17| VoiceConnection interrompida | I playback-errors, bot-v5 | R interrupção controlada |
|18| Reconexão transitória | I voice-connection, bot-v5 | R Ready e pergunta nova |
|19| Reinício worker | U consent/recent-conversation; I bot-lifecycle e instância nova | R não restaurar consentimento |
|20| Brave normal | U game-search; I bot-v5 | R uma busca útil autorizada |
|21| Brave429/timeout | U game-search | R observar se ocorrer; não forçar quota |
|22| Perguntas consecutivas | I multiuser, bot-conversation | R cinco perguntas |
|23| Playback completo | I playback, playback-errors | R confirmação auditiva |
|24| Memória correta | U recent-conversation; I recent-conversation-integration | R continuidade sem mistura |
|25| Revogação | U consent; I bot-v5/multiuser/voice-recognition | R cancelar Kel sem cortar criador |
|26| Personalidade/afeto | U identity/prompt-context como contrato; sem avaliação semântica automática | R roteiro perceptivo da proposta |

## Validação reproduzível no Discord

Este roteiro é para o operador após decidir uma implantação manual. Não foi
executado automaticamente. Usar uma instância do worker e a voz existente.
Cada participante deve entender que a resposta é audível a todos, aceitar
individualmente e evitar dados privados nos testes. Guardar somente métricas e
incidentes sanitizados; não versionar gravações ou transcrições.

1. Registrar revisão implantada/horário, `status` inicial e orçamento de teste.
   Com credenciais no ambiente apropriado: `npm run build` e
   `npm run audit:agent`. Resultado não equivalente ou workflow não revisado
   impede atribuir o tom ao prompt local. Não publicar ajustes automaticamente.
2. Criador sozinho: `/jarvis join`; três `/jarvis tone` sequenciais, cada um
   audível por1 s e player voltando a Idle. Isso não usa ElevenLabs. Depois
   `/jarvis consent` e `/jarvis ask texto:Quanto é dois mais dois?`; confirmar
   áudio e evento do mesmo incidente, sem greeting repetido.
3. `/jarvis consent audio:true` do criador; cinco perguntas breves, identificando
   o jogo na primeira e fazendo uma continuação sobre arma/missão. Confirmar
   wake, transcript final, upload inteiro, áudio e liberação. Respeitar o teto
   STT atual; follow-up só do mesmo ID/janela. Incluir pausa natural no meio e
   uma fala sem wake fora da janela. Não reduzir VAD para ganhar tempo.
4. Kel entra sem consentir: sua voz não gera captura/STT/sessão; criador segue
   perguntando. Depois ela aceita áudio: ambos fazem perguntas, uma simultânea,
   com contexto distinto. Entrada/saída de terceiro não cancela nenhum deles.
   Kel usa `/jarvis revoke` durante seu turno; confirmar corte imediato só dela,
   continuidade do criador e necessidade de novo aceite após saída/reentrada.
   Convidado declarar ser criador não concede acesso a `/leave` ou configuração.
5. Uma pergunta que necessite Brave; conferir fonte/status e liberação mesmo
   se indisponível. Não repetir para provocar429. Distinguir `rate_limit_source`
   local de `provider_429`/quota. Sem resultado, Jarvis admite a limitação.
6. Falha simulada de playback sem custo: executar localmente
   `npx vitest run tests/playback-errors.test.ts` (inclui encoder/player reais
   com falhas controladas e transporte falso). Na call, em janela de manutenção,
   testar breve interrupção de transporte durante um tom. Conferir causa/etapa,
   cancelamento único, recuperação limitada e novo `/tone`, sem replay do antigo.
   Não iniciar uma pergunta paga apenas para produzir a falha. Se a interrupção
   destruir conexão/sala, `/join` e consentimentos novos são obrigatórios.
7. Deixar passar idle 45 s e lifetime 300 s do agente com humanos na sala; o bot
   permanece no Discord, e nova pergunta abre sessão quando necessário. Testar
   `/leave` enquanto recupera: não deve reconectar. Restart exige novo `/join`
   e aceite; nenhuma memória/consentimento presumido do processo anterior.
8. Executar os critérios perceptivos da proposta: plano arriscado, derrota,
   “sem piada agora”, afeto para Kel e convidado. Julgar utilidade, sinceridade,
   naturalidade e respeito; nenhum fato do criador é conhecido sem aprovação.
9. Capturar `status` final e export JSONL sanitizado fora do Git. No PowerShell:
   `Get-Content -LiteralPath 'C:\caminho\render-sanitizado.jsonl' | node scripts/analyze-latency.mjs`.
   Comparar amostras da mesma duração de fala, entrada, carga/fila e configuração
   por revisão. Informar N, falhas, cancelamentos, percentis e população pareada;
   medir audição separadamente do primeiro pacote. Cinco perguntas são um smoke,
   não certificação estatística de p95.

Salas temporárias Elysium: a inspeção somente leitura confirma que
`_room_is_occupied` ignora apenas o ID configurado de Jarvis ao contar ocupação;
humanos presentes impedem exclusão. Quando restam somente Jarvis, a limpeza pode
apagar a sala vazia. O Jarvis também sai quando não restam humanos. Isso é ciclo
de vida esperado, diferente de expiração ElevenAgents. Nenhum Python foi alterado;
associação de algum relato histórico à exclusão exige eventos reais do canal.

## Arquivos e validação final

- Áudio: `src/audio/playback.ts`, `src/audio/capture-window.ts`,
  `src/discord/voice-receiver.ts` e regressões playback-errors/voice-receiver.
- Agente/fila: `src/agents/session-manager.ts`, `src/agents/elevenlabs-client.ts`
  e testes agent-turn/voice-recognition/elevenlabs-client.
- Integração/status: `src/discord/bot.ts`, `src/config.ts`, `.env.example`,
  `src/observability/{metrics,status,operational-evidence}.ts` e testes
  bot-v5/config/observability/status/operational-evidence.
- Brave/análise: `src/tools/game-search.ts`, `scripts/analyze-latency.mjs`,
  testes game-search/latency-analysis; documentação deste relatório, proposta e
  link no README. Nenhum lockfile, arquivo Python ou infraestrutura mudou.

Gate final local: `npm run typecheck`, `npm run lint`, `npm test`,
`npm run build` e `git diff --check` aprovados. **632 testes passaram em 35
arquivos; 1 teste manual de DAVE real foi ignorado.** Baseline: 603 aprovados
em 34 arquivos, 1 manual ignorado. As regressões causais foram executadas antes
das correções e falharam pelos motivos descritos; o conjunto final está verde.
Revisões independentes verificaram cancelamento, isolamento e allowlist.

`python -m compileall bot.py elysium` e os imports documentados no AGENTS.md
também passaram, sem conexão Discord. `audit:agent` e chamadas reais não foram
executados por falta de configuração adequada; nenhum resultado remoto é
inferido a partir do build. Nenhum push, deploy ou alteração remota foi feito.

Commit local de implementação: `205270e` (`fix(jarvis): harden voice recovery
and correlated diagnostics`). A documentação e a proposta de perfil ficam em
commit local separado. Use `git log -2 --oneline` para revisar ambos.

## Rollback e pendências

Antes de autorizar deploy, o operador deve revisar os commits locais e os gates
acima. Rollback do worker: selecionar manualmente a revisão anterior `cfcdd03`,
preservando ambiente/plano/voz e uma instância, sem sincronizar Blueprint para
criar serviço. Em Git, reverter o commit de implementação numa nova revisão
preserva o histórico (`git revert 205270e`). A preparação local não executa
nenhuma dessas operações.
O prompt remoto não mudou e não exige rollback. Restart pede consentimento novo.

Continuam pendentes: revisão Render real, comparação autenticada do agente,
DAVE/rede/ASR e VAD acústicos, audição, estabilidade ociosa com humanos, matriz
multiusuário em call, latência pareada por revisão e avaliação de personalidade.
Os registros D51204EF/D67BF82A originais não estão disponíveis para reconstruir
suas causas. Se um check crítico ou gate real falhar, não aprovar produção.

## Referências primárias

- Código instalado de `@discordjs/voice@0.19.2`: onNetworkingClose/rejoin,
  AudioPlayer e AudioResource, DAVE e receiver, além do lockfile existente.
- [WebSocket ElevenAgents](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket)
  e [client events](https://elevenlabs.io/docs/eleven-agents/customization/events/client-events).
- [Brave rate limiting](https://api-dashboard.search.brave.com/documentation/guides/rate-limiting)
  descreve múltiplas janelas/reset em segundos, inclusive mensal.
- [RFC9110 Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after)
  aceita segundos ou data HTTP.
- [Render: variáveis padrão](https://render.com/docs/environment-variables)
  define `RENDER_GIT_COMMIT` como SHA do serviço/deploy.
