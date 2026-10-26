# OPERAÇÃO JARVIS — auditoria forense de confiabilidade

Investigação iniciada em 25/10/2026, concluída localmente em 26/10/2026.
Correções: `387c2ac` e `df5c743`. Aprovação de produção: **pendente**.

Foram reproduzidos defeitos de perda de causa, cleanup interrompido, Promise de
playback não resolvida e callback antigo afetando um socket reutilizado. As
correções locais foram verificadas antes/depois. Isso **não comprova a causa dos
cinco incidentes históricos nem a estabilidade audível no Discord**.

## 1. Revisão investigada e ambiente

Antes das alterações: branch `main`, HEAD
`a7d7b90d507412e7f200757a5fbaae0c403275a7`. A única pendência era o arquivo
não rastreado `JARVIS_V6_MEMORIA_CODEX.md`, preservado fora dos commits.
Os relatórios V5.6, V5.7, V5.8, P0 e isolamento foram revisados.

| Correções já presentes | Evidência anterior, preservada nesta revisão |
| --- | --- |
| V5.6 | Disponibilidade em todos os estados diferentes de Ready, recuperação limitada, causas do connector, Retry-After, cooldown Brave e métricas correlacionadas. |
| V5.7 (`798a9ad`) | Terminal/liberação únicos, captura no teto explicitamente recusada, renovação por lifetime restante, isolamento de sessão/ferramenta antiga. |
| V5.8 (`4912d6f`) | Parcela wake por participante, continuação única, fila antes de STT, prioridade sem ultrapassagem repetida e feedback limitado. |
| P0 (`7355ba9`) | Reparo de assinatura ausente/obsoleta e proteção contra leitura de descarte contada como playback. |
| Isolamento (`a7d7b90`) | Ensaio único com bot, conexão nativa, player, receiver e manager preservados entre fases. |

Ambiente local: Node 24.19.0, npm 11.17.0, Windows x64; discord.js 14.27.0,
@discordjs/voice 0.19.2, opusscript 0.1.1 e ws 8.22.0, iguais ao lockfile.
Davey nativo pôde ser carregado e uma sessão sintética criada/resetada. Isso
verifica disponibilidade local, não negociação MLS/DAVE de uma chamada.

**O SHA implantado no Render não estava acessível.** Não havia worker Node
ativo, `.env` do Jarvis, credenciais pertinentes no shell, Render CLI ou chave
Render configurada. As ferramentas conectadas disponíveis não forneciam acesso
ao serviço Render deste bot. Não se iniciou outra instância real do worker.

| Configuração | Código/Blueprint local | Produção efetiva |
| --- | --- | --- |
| Instâncias / deploy | Uma; `autoDeployTrigger: off`; `rootDir: jarvis` | Desconhecida. |
| Node / dependências | Versões acima; lockfile preservado | Desconhecidas. |
| Entrada de voz | Blueprint `disabled` | Desconhecida; não foi sobrescrita. |
| Captura / VAD / upload | 12 s totais, silêncio 600 ms, blocos com pacing de 20 ms | Ajustes efetivos desconhecidos. |
| Wake | 6 inícios por janela móvel de 60 s | Desconhecida. |
| Follow-up / sessões | 18 s; duas sessões; idle 45 s; lifetime 300 s | Desconhecida. |
| Log / revisão | `info`; `RENDER_GIT_COMMIT` validado quando fornecido | Desconhecidos. |

O HEAD local nunca preenche o campo de revisão implantada. Nenhuma dependência,
timeout, variável obrigatória, Blueprint ou configuração remota foi alterada.

## 2. Arquitetura do pipeline real

| Caminho | Componentes e fronteira observada |
| --- | --- |
| Recepção | Discord UDP → transporte/DAVE de @discordjs/voice → stream Opus consentido por Discord ID → OpusDecoder → PCM16 48 kHz estéreo → VAD. |
| Admissão de voz | Captura inteira → dedupe/janela → follow-up autorizado ou wake STT → capacidade da fila → pedido serial da sala. |
| Texto | Discord Interaction → autorização/consentimento escrito → mesma fila/SessionManager. Não exige microfone, decoder de entrada ou wake. |
| Agente | Signed URL → WebSocket → metadata PCM → identidade/contexto consentidos → texto ou PCM mono na taxa negociada → reconhecimento final → geração/tools. |
| Saída compartilhada | PCM remoto → StreamingPcm → frames estéreo 48 kHz/960 samples → OpusScript → AudioResource Opus → AudioPlayer → assinatura VoiceConnection → DAVE/transporte Discord. |
| Encerramento | Conclusão remota e drain local são independentes; terminal/liberação únicos; sessão quente pode permanecer até idle/lifetime. Memória recebe somente entrega elegível. |

Os limites existentes permanecem: wake 8 s, reconhecimento final 10 s após upload,
inatividade de resposta 45 s e prazo absoluto padrão de playback 180 s. Não
houve tentativa de mascarar erros com prazos maiores ou upload acelerado.

## 3. Inventário de perda de erro e correções

| Local / primeiro defeito observado | Consequência antes | Correção mínima |
| --- | --- | --- |
| `SessionManager.dispatch/ensure` descartava a exceção ao mapear o código do agente | `AGENT_INPUT_SEND_FAILED` sem classe ou código técnico original. | Preservar classe e causa sanitizadas nos erros de aquisição/envio e no terminal. |
| Connector ignorava exceção de `ws.resume()` | Falha real de retomada TCP ficava sem evento causal imediato; encerramento dependia de eventos posteriores/deadline. | Tratar como transporte, preservar causa e fechar/drenar conforme contrato existente. |
| Rejeição tardia de callback de conclusão verificava somente epoch do transporte | Podia encerrar um socket já reutilizado por outro turno. | Amostrar o ID do turno antes do callback; erro antigo é diagnosticado no ID antigo, sem fechar o turno novo. |
| Exceção em `ws.close()` interrompia `end()` | Socket podia ficar aberto sem `terminate` nem callback final. | Tentar a terminação existente, manter a causa e concluir o callback. O prazo de 1 s existente não foi aumentado. |
| `close` e `terminate` falhando | Não havia resultado explícito para a liberação física malsucedida. | `cleanup_ok=false` e estado do WebSocket permanecem observáveis; não se afirma recuperação. |
| Primeiro `stream.cancel()` que lança em `SessionManager.remove` | Impedia tentar os outros passos de cleanup. | Tentar cada passo isoladamente, registrar a falha/etapa e continuar a limpeza. |
| `player.stop()` que lança em `PlaybackQueue.complete` | Podia escapar antes de resolver/rejeitar `done` e avançar a fila. | Garantir liquidação de `done`, tentativa dos demais passos e próxima reprodução; cleanup falho não vira sucesso. |
| Snapshot secundário de `/tone` substituía o erro anterior | Erro de cleanup apagava encoder/classe/estágio originais no resumo do comando. | Congelar a primeira falha e registrar cleanup separadamente. |
| Callback de captura falhando, síncrono ou assíncrono | PCM era apagado, mas restava somente `voice_turn_errors`. | Registrar causa, incidente e resultado da limpeza, preservando apagamento e próxima captura. |
| Notificação e callback de memória falhando | Apenas contador; erro tardio não tinha diagnóstico técnico por turno. | Eventos com escopo próprio e ID primitivo capturado antes do await. Não criam outro terminal. |
| REST de aviso privado/fallback público falhando | Tratamento de fallback descartava a exceção original. | Diagnosticar antes do fallback, correlacionando o incidente conhecido; manter dedupe e resumo anônimo. |
| Wake STT encapsulando erro de rede/HTTP | Só `wake_provider_failed`, sem causa; rejeição externa podia receber outro ID. | Preservar causa/HTTP status e o incidente da captura. Não alterar quota, pausas ou retries. |
| VoiceConnection convertendo o erro para DiagnosticError | Classe original desaparecia do primeiro evento. | Registrar classe/código seguros na origem, antes da conversão. |
| Transporte falhando depois de playback concluído | Apenas contador de fechamento; causa tardia desaparecia. | `jarvis_agent_late_error` no incidente antigo, sem reclassificar o turno concluído como falho. |
| Wrapper Node com causa em `error.cause` | Código conhecido de DNS/rede aparecia como UNKNOWN. | Ler no máximo um nível de propriedade de dados e aceitar somente códigos conhecidos; não reter objeto/mensagem. |
| Captura e manager criavam correlações independentes | Dificultava ligar receiver, wake, aceite e playback. | ID opaco transportado em metadata interna; aliases explícitos e compatíveis no logger. |

### Tratamentos legítimos preservados

Não se removeram supressões necessárias à segurança do ciclo de vida: falhas de
um sink de diagnóstico não podem provocar recursão; cancelamento de corpo HTTP
não deve aguardar um provedor travado; áudio antigo/revogado é descartado;
edição de aviso apagado pode ser substituída uma vez; mensagens desconhecidas do
protocolo não autorizam novas ações. Respostas de erro upstream não são logadas.

`Logger.observe`, probes e callbacks de diagnóstico continuam cercados. Isso
não garante entrega de logs quando o próprio stdout/coletor externo está
indisponível. Essa limitação de infraestrutura exige coleta operacional e não
foi disfarçada como garantia absoluta de “zero falhas”.

## 4. Primeiro ponto de falha e incidentes históricos

| Incidente | Evidência realmente disponível | O que falta para a causa original |
| --- | --- | --- |
| `D51204EF` | Resumo histórico: texto, resposta textual observada, um chunk de 33.884 bytes, `PLAYBACK_FAILED` após aproximadamente 1,08 s. | Exceção original, estágio da saída, estados/assinatura/DAVE e SHA implantado. |
| `D67BF82A` | Evento histórico genérico `jarvis_command_failed`. | Comando, etapa, exceção e SHA; não permite afirmar que foi `/tone`. |
| `2A4831B0` | Relato de `OPUS_DECODER_FAILED`. | Registro da inicialização, classe/código nativo, versão/ambiente efetivos e estado da captura. |
| `4C09D8B0` | Relato de pergunta não respondida. | Último progresso correlacionado, entrada aceita/recusada, terminal/liberação e SHA. |
| `B4C09469` | Relato de reprodução interrompida. | Primeiro pacote, erro anterior a Idle, transportes, terminal e SHA. |

Os anexos e relatórios históricos foram consultados sem publicar conteúdo
privado. Não há export completo que recupere as exceções ausentes. Os cinco IDs
não foram atribuídos a eventos sintéticos. O tamanho de D51204EF continua tendo
regressão local que produz 53 pacotes Opus válidos; isso não reconstitui seu áudio
nem prova que a produção chegou a despachá-los.

Nos controles injetados, o primeiro erro é conhecido: decoder antes de PCM,
retomada TCP, callback antigo, encoder/player ou passo de cleanup. `PLAYBACK_FAILED`,
timeout posterior, Idle e rejeição da próxima pergunta podem ser consequências.
O primeiro erro técnico preservado deve ser lido com `failure_scope`; falha de
notificação não é automaticamente a causa da entrega de áudio.

## 5. Causas confirmadas e hipóteses

Confirmadas **localmente**: os defeitos da seção 3, incluindo Promise de playback
que podia permanecer pendente e cleanup/socket interrompidos. São causas
demonstradas para os cenários reproduzidos, não uma explicação única para a
experiência após três ou quatro interações.

Não confirmadas em produção: perda de assinatura, bug de encoder/decoder,
negociação DAVE, problema do host Render, eventos/configuração do agente, quotas
da conta ou falha acústica de wake. O callback de conclusão do manager atual é
síncrono; a rejeição tardia foi demonstrada no contrato assíncrono permitido pelo
adapter. Não se afirma que esse mecanismo explica um incidente real existente.

O padrão de 12 s inclui o fim da captura. Fala longa sem fim VAD antes do teto
deve ser recusada explicitamente, não enviada como prefixo completo. A maior
latência de um upload com pacing é esperada; não justifica alterá-lo sem medida.

## 6. Evidência antes/depois

Asserções vermelhas foram executadas antes da respectiva correção, em etapas do
mesmo trabalho. Não se apresenta essa sequência como uma execução única de todas
as regressões contra a baseline limpa.

| Regressão / arquivo | Antes | Depois |
| --- | --- | --- |
| Envio por texto — `agent-turn` | Faltavam TypeError/ECONNRESET no terminal. | Causa retida e pergunta seguinte concluída. |
| Notificação — `agent-turn` | Nenhum evento com classe/código e incidente. | Diagnóstico no turno correto e fila livre. |
| Cancelamento — `agent-turn` | RangeError escapava e interrompia cleanup. | Outros passos tentados, erro registrado, turno seguinte funcional. |
| Captura sync/async — `voice-receiver` | Diagnóstico ausente em ambos os casos. | PCM apagado, causa visível, próxima captura entregue. |
| Retomada TCP — `elevenlabs-client` | Nenhum `agent_transport_error` após a falha de resume. | Erro imediato com TypeError/ECONNRESET e fechamento observado. |
| Callback de conclusão antigo — `elevenlabs-client` | `agent_callback_error` fechava a sessão nova. | Aviso no turno antigo, socket novo turno permanece utilizável. |
| Fechamento de socket — `elevenlabs-client` | TypeError escapava antes da terminação. | Fallback existente executado, callback final único. |
| Fechamento/terminação ambos falhando — `elevenlabs-client` | Snapshot não indicava cleanup malsucedido. | `cleanup_ok=false`, socket ainda aberto explicitamente indicado. |
| Player stop — `playback-errors` | Exceção escapava antes da rejeição de `done`. | `done` rejeitado; novo recurso termina normalmente. |
| Segundo erro em `/tone` — `bot-command-errors` | Cleanup substituía RangeError do encoder. | Primeiro erro preservado, segundo separado. |
| Wake transporte/manager e conexão — `wake-detector`, `agent-turn`, `voice-connection` | Três verificações sem causa/classe originais. | Classe/código e incidente preservados. |
| Causa Node aninhada — `observability` | ENOTFOUND virava UNKNOWN. | ENOTFOUND preservado sem objeto ou getter. |
| Erro após playback concluído — `agent-turn` | Somente contador, sem exceção por incidente. | Aviso técnico antigo, nenhum novo terminal falho. |
| REST do aviso com fallback — `bot-v5` | Causa perdida antes do resumo público. | Diagnóstico original no incidente da captura e um fallback. |

Novos testes também verificam aliases/revisão, proteção contra getters e dados
privados, causa original preservada após cleanup, callback tardio de memória e
HTTP 429/502 sem retry. Alguns testes antigos de chaves JSON foram ajustados
somente para os aliases novos; as assertivas contra segredos continuam ativas.

## 7. Alterações e contrato de observabilidade

Commits locais: `387c2ac` (causas, ciclo de vida e correlação) e `df5c743`
(causa de falha REST em feedback). Não houve reescrita do SessionManager.

- Agentes: `src/agents/{session-manager,elevenlabs-client,wake-detector}.ts`.
- Áudio/Discord: `src/audio/{capture-window,playback}.ts` e
  `src/discord/{bot,voice-receiver,voice-connection}.ts`.
- Diagnóstico: `src/observability/{diagnostics,metrics,operational-evidence}.ts`.
- Regressões: arquivos citados acima e o ensaio `tests/fault-isolation.test.ts`.

`incident` permanece compatível. `incident_id` o espelha; `turn_id` identifica o
mesmo turno opaco e acompanha a captura até o terminal. Não é Discord ID nem
provider ID. `error_code` espelha o código revisado, sem substituir `code`.
`deployed_revision` só é anexado quando validado a partir da configuração Render.

| Evidência por turno | Evento/metadata |
| --- | --- |
| Criado/aceito e fila | `jarvis_turn_created`, `jarvis_turn_queue_changed`. |
| Captura iniciada, concluída, PCM liberado | `jarvis_voice_capture_state`, `capture_event=started/completed/released`. |
| Wake aceito/recusado | `jarvis_wake_detected`, `jarvis_wake_failed`, `rejection_reason`, `retry_after_ms`. |
| Sessão/upload/reconhecimento | `jarvis_agent_connection_stage`, `session_ready`, `input_started/input_sent`, `user_turn_recognized`. |
| Texto observado/conclusão de geração | `response_observed`, `response_complete`; texto observado sozinho não prova geração integral. |
| PCM remoto/player | `first_audio`, etapas `resource_created/play_called/packet_read`, transições do player e `playback_token`. |
| Drain e resultado | `audio_progress`, `playback_completed`, `turn_finished/turn_failed/turn_cancelled`, `turn_released`. |
| Cleanup e falha secundária | `jarvis_cleanup_failed`, `jarvis_agent_resources_released`, `jarvis_turn_callback_failed`, `jarvis_agent_late_error`, `interaction_response_failed`. |

Falhas recebem classe/código seguros, estágio, escopo, duração, fila e snapshots
do player/conexão e WebSocket quando disponíveis. Estado ausente não é inventado.
`websocket_state` usa os estados 0/1/2/3 da biblioteca. `http_status` é numérico
limitado; nunca se retém corpo de erro. `cleanup_step` e `cleanup_ok` distinguem
tentativa falha de finalização. Cleanup de sessão pode iniciar CLOSE assíncrono:
o booleano não substitui verificar o estado final do socket e a terminação.

O status retém o primeiro erro técnico sanitizado e a primeira falha de playback,
separados dos campos mais recentes. Retenção limitada: 64 incidentes e 16 etapas
de saída por incidente. Logs completos devem ser coletados no serviço. Não há
stack bruta, áudio, transcrição, pergunta, resposta, URL assinada, segredo ou
identificador pessoal nos novos campos. A inspeção de `error.cause` é limitada a
um nível e somente propriedades de dados; getters e objetos não são serializados.

## 8. Gates executados e limites

| Gate | Resultado |
| --- | --- |
| Baseline recebida | 752 testes aprovados, 40 arquivos, um gate real ignorado, conforme entrega anterior. |
| Gate final desta revisão | **774 testes aprovados, 40 arquivos, um gate real ignorado.** |
| Typecheck / lint / build / diff check | Aprovados. |
| Benchmark | Aprovado antes/depois; detalhes na seção 10. |
| Discord/Render/ElevenLabs pagos | Não executados: acesso/configuração indisponíveis. |
| Alteração remota, push ou deploy | Não executados. |

Comandos em `jarvis/`: `npm run typecheck`, `npm run lint`, `npm test`,
`npm run build`, `npm run benchmark`. No Windows, `npm.cmd` foi usado.
O gate DAVE real ignorado continua explícito; não foi substituído por mock verde.

## 9. Resistência com estado preservado

O ensaio nativo único foi ampliado: 20 tons → 20 perguntas escritas, dez curtas e
dez longas → entrada/wake isolados → 20 interações alternadas texto/voz. Uma
pergunta escrita adicional verifica disponibilidade durante backoff. Resultado:
20 tons e 41 turnos de perguntas concluídos/liberados uma vez. Na integração,
um erro real do decoder de entrada é provocado durante uma pergunta escrita;
ele recebe outro incidente e não cancela a saída textual.

O mesmo JarvisBot, VoiceConnection nativa, VoiceConnectionManager, AudioPlayer,
PlaybackQueue, SessionManager, receiver e wake permanecem. Um segundo
participante concede áudio sem revogar/zerar a sessão do participante de texto.
Buffers voltam a zero; fila/checking/capturas ficam vazios; resources são
destruídos; listeners e timers não crescem. Sessões quentes são limitadas aos
participantes e correspondem aos sockets abertos. Shutdown exige zero timers.

Transporte gateway/UDP e provedor são controlados. Pacotes são injetados após a
fronteira de decriptação; não há prova de MLS, som ouvido ou reconhecimento PT-BR.

| Cenário prioritário | Cobertura mantendo o runtime entre turnos |
| --- | --- |
| Dez curtas + dez longas | `fault-isolation`: 20 textos; `conversation-endurance` também cobre capturas longas configuradas de 15/20 s sem truncar a fonte. |
| Dez alternadas | Vinte interações do ensaio único e duas pessoas em `conversation-endurance`. |
| Falha no quarto e recuperação | `output-endurance`/`conversation-endurance`: falha injetada no quarto e sequência até o vigésimo. |
| Playback falha, depois pergunta nova | Encoder/start/player/Idle prematuro e stop com exceção; próximo recurso/turno conclui. |
| Opus de entrada falha durante texto | Sétima interação integrada no ensaio único, sem falha do texto. |
| Socket antigo fecha com turno novo ativo | Sequências de eventos antigos e callback de conclusão tardio, IDs antigos preservados. |
| Sem evento de conclusão | Dez respostas retiradas como não confirmadas, sem fabricar sucesso completo; depois pergunta normal. |
| Dois participantes | Consentimento/ID separados, revogação de um sem cancelar o outro; presença sem consentimento não compra captura/STT. |
| Idle e nova interação | Expiração do provedor mantém Discord/consentimento; nova sessão atende. |
| Backpressure/resposta longa | Respostas de 20 s e buffers limitados, cancelamento e recuperação; transporte real pendente. |

O ensaio complementar de saída mantém AudioPlayer real por 20 perguntas com
encoder falhando no terceiro e transporte no quarto: 18 concluídas, uma falha e
uma parcial. Os 20 tons com falhas 3/4 têm 18 conclusões e duas falhas. Esses
controles não entram como sucesso para melhorar percentuais.

## 10. Métricas comparáveis antes/depois

Comparação do benchmark existente: fonte da baseline `a7d7b90` e correção
`387c2ac`, mesma máquina, Node, fixtures, dependências e parâmetros. O complemento
`df5c743` trata REST de feedback e não é exercitado por esse benchmark do pipeline.
As execuções são sequenciais, sem suíte concorrente; variação do host/GC continua
possível. Não se misturam médias históricas de produção a esse ensaio.

CPU sintética em ms, **p50 / p95 / máximo**, N=25 por célula, cinco warmups:

| Caso | Antes | Depois |
| --- | --- | --- |
| Captura 48k estéreo → 16k mono, 1 s | 11,819 / 13,031 / 13,959 | 11,922 / 12,585 / 14,324 |
| Mesma conversão, 3 s | 34,746 / 39,507 / 40,027 | 36,312 / 43,358 / 44,186 |
| Playback 16k → 48k, 20 ms | 0,410 / 0,423 / 0,426 | 0,423 / 0,448 / 0,470 |
| Playback 24k → 48k, 20 ms | 0,398 / 0,461 / 0,547 | 0,397 / 0,541 / 0,588 |
| Streaming, primeiro frame | 0,172 / 0,211 / 0,316 | 0,186 / 0,283 / 0,692 |
| Streaming completo, 1 s | 8,007 / 8,238 / 8,258 | 8,124 / 9,562 / 33,695 |

Há aumentos de p95/máximo; os algoritmos de conversão não mudaram. Esse ensaio
não isola o host para atribuir causalmente essas diferenças às correções, nem
mede o custo integral dos novos logs. Nenhum ganho de CPU/latência é declarado.

As distribuições do pipeline virtual foram **idênticas antes/depois**, incluindo
contagens/outcomes. Submissão/captura → primeiro pacote local, em ms:

| Cenário | N | p50 | p95 | Máximo |
| --- | ---: | ---: | ---: | ---: |
| Texto | 5 | 1526 | 1526 | 1526 |
| Voz curta | 5 | 5686 | 5686 | 5686 |
| Voz longa da fixture | 5 | 11686 | 11686 | 11686 |
| Consecutivas | 10 | 2196 | 2866 | 2866 |
| Dois falantes | 10 | 2439 | 3352 | 3352 |
| Conclusão ausente | 10 | 1526 | 1526 | 1526 |

No cenário sem conclusão, há cinco confirmadas e cinco não confirmadas, não dez
sucessos. Drain → liberação continua p50=1987, p95/máximo=3974 ms, N=10.
As medidas acima incluem o início da captura/submissão, não são fim de fala →
audição real. São relógios/modelos de protocolo, não latência do Discord.

Para produção, coletar por turno `wake_detection_ms`, `question_wait_ms`,
`agent_connect_ms`, `upload_ms`, `remote_first_audio_ms`, `first_playback_ms`,
`speech_end_to_first_packet_ms`, `drain_ms` e `next_question_ready_ms`. A transição
Playing tem timestamp e elapsed do recurso. Audição exige observação humana.
Campo ausente permanece ausente, inclusive reuso, follow-up e áudio precoce.

O analisador existente produz N/p50/p90/p95/máximo por etapa. Comparar exports
separados por SHA/processo, origem, duração, fila e configuração; incluir falhas.
Não somar percentis independentes nem confundir áudio observado com confirmação.

## 11. Coleta no Render na próxima ocorrência

1. Registrar o SHA do deploy realmente ativo, horário de início, número de
   instâncias e ajustes não secretos. Não usar `git rev-parse HEAD` local como
   prova do SHA remoto. Não reiniciar para fazer o sintoma desaparecer antes da coleta.
2. Obter `/jarvis status detalhes:true` inicial e o incidente de cada `/ask` ou
   `/tone`. Consultar imediatamente `/jarvis status incidente:XXXXXXXX`.
3. Exportar somente logs estruturados sanitizados desse processo e filtrar
   `incident`/`incident_id`/`turn_id`. Separar join/recovery de pergunta, mantendo
   os eventos de transporte do mesmo intervalo para contexto.
4. Procurar o primeiro erro antes de Idle/cleanup. Guardar `stage`, `category`,
   `error_code`/`code`, classe/causa, player/voice/socket, assinatura, DAVE,
   contagens codificadas/consumidas, fila, duração, escopo e cleanup. O erro
   secundário não substitui o primeiro; snapshots pós-limpeza têm outro significado.
5. Conferir exatamente um terminal/liberação para cada pergunta aceita. Se
   houver timeout, identificar qual prazo venceu e o último progresso, sem aumentá-lo.
6. Para os cinco IDs históricos, consultar o processo/export que os gerou. Se
   não existem mais, declarar indisponibilidade; não inferir pelo contador acumulado.

Análise local, dentro de `jarvis/`, com JSONL previamente obtido pelo operador:

```powershell
Get-Content -LiteralPath 'C:\caminho\logs-sanitizados.jsonl' | node scripts/analyze-latency.mjs
```

O analisador não acessa a rede e descarta campos não revisados. Conferir
`ignored_lines`; prefixos textuais do Render não são JSONL. Não exportar ambiente,
payloads WebSocket, transcrições, áudio ou signed URLs. A memória do status é
limitada ao processo; retenção de logs do serviço é necessária para histórico.

## 12. Configurações e política de wake a revisar

Conferir SHA, Node/pacotes e configuração efetiva listada na seção 1. Revisar
também `JARVIS_MAX_QUEUED_TURNS`, `JARVIS_MAX_QUEUED_PER_USER`, TTL de fila,
supressão de first message, client events/formatos PCM, workflow/turn-taking e
limites da conta ElevenLabs. `audit:agent` é somente leitura, exige configuração
válida e não substitui revisão de workflows ou teste audível. Não foi feita
consulta autenticada nem alteração do agente publicado nesta investigação.

Seis wakes/minuto continuam sendo seis no worker. Dois consentidos têm até três
inícios por ID na janela móvel. Duas falas reconhecidas sem wake podem iniciar
pausas de 10/20/40/60 s daquele participante. Rejeições durante a pausa não
compram STT nem estendem o prazo; erro/cancelamento não conta como fala negativa.
Fila cheia é verificada antes de comprar STT. Texto permanece disponível.

Evidência quantitativa preservada: dez capturas ambientes rápidas de um
participante compram duas verificações e oito recusas locais; uma ativação do
outro totaliza três chamadas. Os dois papéis são testados. Reconsentimento não
devolve o custo já consumido. Dedupe de avisos não altera a admissão das perguntas.

Isso não garante intenção acústica: com dois usuários há em média capacidade de
três verificações por usuário/minuto, e uma wake legítima durante a pausa pode
ser recusada. Não há evidência real suficiente para declarar uma arquitetura
substituta superior. Se o teste multiusuário confirmar inadequação, a proposta
separada é comparar detecção local antes de STT pago, medindo PT-BR, falsos
positivos/negativos, custo e latência com consentimento. Migração/modelo/biblioteca
exigem decisão posterior; não foram implementados.

## 13. Rollback

Os commits são locais. Para reversão futura revisada, reverter primeiro
`df5c743` e depois `387c2ac`, criando novos commits; base anterior `a7d7b90`.
Não foi executado reset, push, deploy ou rollback. No Render, usar o último SHA
operacional **verificado**, não presumir que a base local era o deploy estável.
Manter uma instância e o ambiente existente. Reinício exige novos consentimentos.
Não há migração de banco, pacote, variável obrigatória ou agente remoto a reverter.

## 14. Validação real obrigatória — todos os cenários pendentes

Executar somente depois de o operador autorizar a implantação e registrar seu
SHA. Usar o mesmo worker em todas as interações, mantendo estado entre elas.
Não passar à complexidade de voz antes da aprovação audível de A e B.

| Teste | Roteiro e critério |
| --- | --- |
| A — dez tons | `/jarvis join`; dez `/jarvis tone` sequenciais pelo criador. Ouvir cada tom inteiro, conferir incidentes, Idle e assinatura. Zero ElevenLabs. Se falhar, parar na saída. |
| B — dez textos | Consentimento sem áudio para o teste; dez `/jarvis ask`, esperando cada encerramento. Captura/STT não crescem, respostas são audíveis e a próxima pergunta entra. Se falhar, não reativar voz. |
| C — dez vozes | Após A/B, consentimento individual explícito; dez perguntas curtas, wake/follow-up e quotas respeitados. Registrar reconhecimento, PCM, reprodução e liberação. |
| D — perguntas longas | Perguntas de 3/8 s dentro do teto; fala contínua que excede 12 s deve ser recusada com motivo, sem enviar prefixo. Não aumentar limite para fazer o teste passar. |
| E — Azrael/Kel | Primeiro Kel sem consentimento: nenhum processamento dela, sem bloquear Azrael. Depois ambos consentem e alternam perguntas/contextos; revogar um sem cortar o outro. |
| F — erro e retomada | Em manutenção autorizada, cancelamento explícito durante resposta e pergunta nova; interrupção controlada de transporte durante tom quando viável. Falhas reais que ocorrerem exigem diagnóstico original e retorno verificado. Não gastar quota para provocar 429 nem criar comando de injeção em produção. |
| G — inatividade | Aguardar idle e lifetime do agente, mantendo o bot no Discord; nova pergunta deve abrir/reusar sessão saudável sem novo join indevido. |
| H — conversa prolongada | Vinte interações totais, com alternância, pausas, perguntas longas e uma busca Brave. Nenhum terminal/aviso duplicado, fila presa ou parcial contado como completo. |

Além disso: humanos antes/depois do bot, transições MLS/DAVE, entrada/saída e
reconexão precisam de verificação real. Inicialização nativa e stream sintético
não comprovam decriptação, UDP, reconhecimento ou audição. Captura deve respeitar
ID e consentimento em cada cenário. Respeitar quotas e cooldown; não zerá-los
revogando/reconsentindo ou reiniciando para ocultar falhas.

Registrar por tentativa: SHA, início do processo, horário, cenário/número do
turno, incidente, duração da entrada, latências técnicas disponíveis, resultado
audível e último estado/cleanup. Não guardar conteúdo privado. Se a percepção
humana for usada para latência, declarar sua precisão; não inventar milissegundos.

Reprovar se houver falha sem causa técnica acessível, resposta cortada sem motivo,
fila permanentemente ocupada, evento antigo afetando pergunta nova, captura sem
aceite, spam de avisos ou aumento injustificado de custo. Nenhum desses critérios
foi declarado aprovado em produção por este relatório.

## 15. Custos, riscos e conclusão técnica

Não foram adicionadas chamadas externas, retries de conversa, banco, Ollama,
bibliotecas, intents, permissões ou serviços. Voz, personalidade, identidade,
consentimento, memória curta, Brave e Elysium Python foram preservados. O custo
novo é metadado técnico de logs e objetos pequenos/limitados; não há log por frame
de áudio ou retenção de exceção bruta. O custo total de coleta/retensão do Render
não foi medido e deve ser acompanhado operacionalmente.

As correções tornam falhas antes silenciosas observáveis e impedem os bloqueios
reproduzidos. Não restauram informação que os incidentes históricos perderam.
Se a própria dependência falhar tanto ao fechar quanto ao terminar um socket,
o diagnóstico permanece falho; não existe garantia fictícia de liberação física.
Erro de sink/coletor também exige observação externa. UNKNOWN continua explícito
quando nenhuma classificação segura é conhecida.

**Entrega técnica local verificada; causa dos incidentes históricos e aprovação
de produção pendentes.** O próximo evento pode ser investigado por turno desde a
captura até cleanup, sem publicar áudio, transcrições ou segredos. A aprovação
final depende dos testes reais do operador, principalmente texto e reprodução
repetidos antes do reconhecimento integrado.
