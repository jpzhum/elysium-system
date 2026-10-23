# Incidentes de áudio — 23/10/2026

## Conclusão e limites da evidência

Base publicada examinada: `343f2df`; também foi revisado o diff local V5.5.
Não há export de logs Render neste checkout nem acesso a uma chamada Discord
conectada. Não foi iniciada outra instância do bot. Os dados históricos abaixo
foram fornecidos pelo operador; os demais resultados são testes locais.

**Não é possível recuperar a exceção original de `D51204EF` nem determinar se
`D67BF82A` foi `/jarvis tone` a partir dos registros disponíveis.** Os registros
anteriores descartaram essa informação. Foram reproduzidos e corrigidos três
defeitos locais de playback, além da perda de diagnóstico. Atribuir qualquer um
deles ao incidente histórico exigiria evidência que não foi preservada.

Não houve aumento de timeout, retry de provedor, mudança de consentimento,
identidade, memória curta, personalidade ou ferramentas autorizadas. O Elysium
Python não foi alterado. Push, deploy e chamadas ElevenLabs/Brave não foram feitos.

## D51204EF: percurso e causas demonstradas

O operador informou `PLAYBACK_FAILED` aproximadamente 1.084 ms após início de
uma pergunta textual, com texto e um primeiro chunk de 33.884 bytes recebido.
Isso demonstra saída do agente, mas não comprova envio ou audição no Discord.
O resumo vinha de `SessionManager.onAudio`: rejeições de `stream.done`, criação
do stream e escrita eram substituídas por `PLAYBACK_FAILED`, sem a exceção.

| Defeito comprovado por regressão | Correção restrita |
| --- | --- |
| `player.play()` lança por recurso encerrado; `pump()` substitui a exceção; `write()` vê `settled=true` e converte a falha em cancelamento. | Preservar a primeira falha em `done` e `write`, com código, etapa e snapshot seguros. |
| O listener de erro do stream encerra A e inicia B dentro do mesmo `emit`. O listener remanescente de `@discordjs/voice` associa o erro ao recurso atual B. | Liberar/cancelar A imediatamente e adiar somente o avanço da fila até a microtask seguinte. A guarda impede outro `pump` durante esse intervalo. |
| A fila começa com `disconnected=false` mesmo se a conexão já não está `Ready`, até aparecer outro `stateChange`. | Inicializar a guarda pelo estado real da conexão e rejeitar com código seguro. |

A regressão de concorrência usa o **AudioPlayer real da versão instalada
0.19.2**, com transporte Discord falso. Antes da correção, o erro de A falhava
B; depois, B permanece ativa. Eventos tardios de recursos antigos não encerram
a reprodução atual. O cancelamento continua imediato, inclusive após revogação.

`tests/playback-errors.test.ts` cobre perda de conexão ativa e com fila,
conexão inicialmente indisponível, recurso encerrado, falha real de `player.play`,
exceção de encoder, erro e transições do AudioPlayer, isolamento do próximo
recurso e liberação do codec exatamente uma vez enquanto aguarda PCM.

### PCM, Opus, streaming e DAVE

- PCM16 mono negociado segue por `StreamingPcm` para PCM16 48 kHz estéreo,
  frames de 960 samples por canal (20 ms, 3.840 bytes), e OpusScript. O recurso
  recebe pacotes Opus com `StreamType.Opus`; não há segunda conversão Raw/FFmpeg.
- O caso exato de tamanho informado, 33.884 bytes a 16 kHz, gera **53 pacotes**
  no teste com encoder e AudioPlayer reais, termina sem falha e zera o buffer.
  Um chunk não precisa coincidir com a fronteira de um frame. Isso testa o
  formato, não o áudio privado do incidente nem a entrega pela rede.
- Os testes existentes mantêm reprodução progressiva antes do fim de ingress,
  conversão contínua, limite de memória, backpressure e cancelamento. Não foi
  demonstrado defeito de formato ou encoder para esse tamanho de entrada.
- A assinatura é observada pela igualdade entre a assinatura mantida pela fila
  e `connection.state.subscription`. O snapshot inclui `voice_status`,
  `network_status`, estados anterior/atual do player e `resource_ended`.
- DAVE usa `networking.state.dave.protocolVersion` e `dave.session.ready`.
  Um teste preserva `voice_status=ready` e `dave_ready=false` simultaneamente;
  não se infere DAVE pronto somente pelo estado VoiceConnection. Nenhuma
  configuração de criptografia ou intent foi alterada.

O `AudioPlayerError` da biblioteca cobre erros do stream do recurso. Exceções
de envio/encriptação em `prepareAudioPacket`/`dispatchAudio` podem ocorrer fora
desse evento. Não foi introduzido monkeypatch de transporte ou DAVE sem causa
comprovada; o snapshot por turno deve ser comparado com os eventos de conexão
existentes. Os estados reais de produção desses incidentes continuam ausentes.

Logs novos: `jarvis_playback_state` e `jarvis_playback_failed`, vinculados ao
incidente do turno ou de `/tone`. Campos revisados incluem `playback_stage`,
`code`, `category`, `cause_code`, `cause_name`, `opus_error_code` quando conhecido,
assinatura e estados reais. O resumo `PLAYBACK_FAILED` mantém a classificação
causal capturada. Mensagens, stack, URLs e objetos upstream não são enviados
ao logger. Erros desconhecidos continuam classificados como desconhecidos;
não se inventa uma causa nem se imprime texto possivelmente privado.

## D67BF82A: por que o comando perdeu a causa

Em `bot.ts`, apenas `join` criava `JoinDiagnostics`. Para os demais comandos,
o catch genérico chamava literalmente
`logger.event('jarvis_command_failed', 'warn')`, sem nenhum campo da exceção ou
do comando. Além disso, a allowlist do logger só aceitava `command='join'`.
O registro fornecido é compatível com qualquer comando que alcançasse esse
catch genérico; não identifica `/tone` nem o código técnico original.

Agora todos os comandos tratados registram subcomando, grupo `context` quando
aplicável, categoria, código seguro, etapa e duração. Falhas de `/tone` incluem
o snapshot de playback e usam o mesmo incidente em player, comando e resposta.
Uma falha secundária ao responder ao Discord preserva esse incidente e informa
seu próprio código. O catch externo também classifica exceções que escaparem
antes da identificação do comando, usando `command=unknown`.

Os testes de comando cobrem o tom sem chave ElevenLabs, exceções de playback,
recurso, encoder, conexão perdida seguida de cancelamento, erro desconhecido,
autorização, canal, acknowledgement Discord, fila de `/ask`, falha da resposta
de erro e rejeição de dados privados pelo logger. O buffer do tom é apagado
em `finally`, inclusive nas falhas.

## Recepção, turnos não reconhecidos e reuso

`voice_receive_errors=73` antes agregava erros do stream, subscribe e construção
do decoder. `voice_decode_errors=1` era contado separadamente. No código da
biblioteca instalada, parse/decriptação podem encerrar um stream antes de
existir PCM ou voz utilizável; erros tardios podem ocorrer após cleanup. Não
há correspondência de um evento para uma pergunta perdida.

`jarvis_voice_receive_error` passa a indicar `receive_stage`, categoria/código,
estado da conexão e os booleanos `capture_active`, `capture_has_pcm` e
`capture_has_voice`. Contadores novos separam origem e classificação; os
contadores históricos mantêm a semântica. Testes distinguem parse, transporte,
DAVE, setup, decode e erro tardio sem afetar uma captura sucessora. Sem logs
originais não é possível distribuir os 73 eventos nessas categorias.

No código atual, `agent_user_turn_missing` ocorre após upload completo e
10 segundos sem `user_transcript` final válido; respostas iniciais não substituem
reconhecimento. Os testes cobrem transcript final vazio/tentativo, upload
incompleto, cancelamento e reconhecimento válido. Não foi demonstrada uma causa
única dos 29 eventos históricos nem duplicação desse contador na revisão atual.
Não se desbloqueou uma saudação como se fosse resposta ao usuário.

`agent_session_reused=0` não demonstra defeito: identidade, consentimento, canal,
contexto e sessão saudável precisam continuar válidos. Falha, fechamento do
provedor, geração sem conclusão, idle ou expiração retiram a sessão. Os testes
de múltiplos turnos confirmam reuso. Os 98 inícios de sessão não são denominador
válido para os 29 turnos de voz sem reconhecimento.

## Métricas e atrasos

As médias fornecidas são: fila **5.173,5 ms**, upload **4.491,4 ms**, captura +
VAD **2.859,6 ms**, STT **686,1 ms**, abertura **535 ms**, fim do upload até
primeiro áudio **365,8 ms** no subconjunto disponível. Não permitem obter p50,
p90 ou p95 de produção e não devem ser somadas entre populações distintas.
Upload inclui pacing de áudio em blocos de 20 ms e silêncio final.

As alterações locais de desempenho foram revisadas e verificadas: cache
limitado de coeficientes sinc com equivalência de bytes nas taxas testadas,
percentis em janela de 256 amostras e separação de etapas. Dois eventos já
emitidos pelo diff local (`jarvis_agent_input_prepared`,
`jarvis_agent_first_audio`) faltavam na allowlist e foram habilitados. A
correlação da abertura agora captura o incidente antes dos awaits, evitando
atribuir um callback tardio ao turno substituto.

O extrator offline `scripts/analyze-latency.mjs` calcula distribuições por
incidente, informa N, outcomes e população pareada, sem reter conteúdo. Os
benchmarks sintéticos existentes mostram melhoria local de CPU, não medição de
produção: captura de 1 s passou de p50/p95 **31,440/35,584 ms** para
**12,056/15,999 ms**; streaming de 1 s, **25,400/26,615 ms** para
**7,743/8,213 ms**. Isso não explica sozinho segundos de fila/upload.

Brave: 5 invocações, 3 sucessos, 2 resultados limitados não comprovam dois
HTTP 429. `rate_limit_source` agora distingue concorrência local, intervalo
local, cooldown de quota e HTTP 429/cooldown. Nenhuma requisição adicional ou
retry foi introduzido. Veja [a auditoria de métricas](INCIDENT_METRICS_REVIEW.md)
e [os benchmarks locais](V55_PERFORMANCE_REVIEW.md).

## Validação real no Discord, após atualização manual pelo operador

1. Manter uma única instância do worker. Selecionar conscientemente a revisão
   para atualização; este trabalho não publica ou implanta o commit. Com logs
   `info`, guardar um export JSONL sanitizado e os deltas de `/jarvis status`.
2. Criador na chamada: `/jarvis join`, depois três `/jarvis tone` sequenciais.
   Confirmar **audição real** de um segundo de tom em cada tentativa e retorno
   a Idle. Conferir `playback_started/completed` e eventos com `command=tone`.
   Não deve haver nova sessão ElevenAgents ou pesquisa por causa do tom.
   O modo DAVE smoke também permite esse teste sem chaves ElevenLabs.
3. Se o tom falhar, correlacionar `jarvis_playback_failed` e
   `jarvis_command_failed` pelo mesmo incidente. Revisar `playback_stage`,
   código, assinatura, `voice_status`, estados do player e DAVE; preservar o
   registro seguro, sem copiar URLs, transcrições ou credenciais.
4. Com consentimento textual, enviar uma pergunta curta por `/jarvis ask`.
   Confirmar áudio ouvido e eventos de primeiro áudio/pacote, conclusão e
   drenagem no mesmo incidente. Texto recebido sozinho não aprova playback.
5. Com consentimento de áudio explícito, testar uma pergunta curta com wake e
   um follow-up. Verificar upload terminado, reconhecimento final e resposta;
   observar reuso somente quando a sessão anterior terminar saudável. Registrar
   origem dos erros de recepção e se existia captura/PCM/voz.
6. Com dois participantes consentidos, enfileirar perguntas e cancelar/revogar
   uma. Conferir identidade Discord, ausência de vazamento de contexto, próxima
   resposta íntegra e interrupção imediata da reprodução revogada. Em ambiente
   controlado, desconectar durante um tom, reconectar e repetir; renovar os
   consentimentos quando exigido. Não atribuir o cancelamento à próxima pessoa.
7. Usar uma pesquisa real somente se necessária; não repetir para forçar
   limite. Observar `rate_limit_source`. Exportar os eventos e executar, em
   `jarvis/`, `Get-Content -LiteralPath 'C:\caminho\render.jsonl' | node scripts/analyze-latency.mjs`.
   Comparar p50/p90/p95, N e outcomes em populações iguais. Aprovação final
   depende de audição, ausência de falhas novas e estabilidade entre turnos.

## Referências e evidências

Verificação final local: `npm run build`, `npm run typecheck`, `npm run lint`
e `npm test` aprovados; **603 testes passaram em 34 arquivos, 1 teste manual
de DAVE real pulado**. Também passaram compileall e os imports documentados do
Elysium Python, sem conexão Discord. Benchmarks CPU/pacotes/VAD e smoke do
extrator foram executados offline. `git diff --check` passou. O documento local
`JARVIS_V6_MEMORIA_CODEX.md`, de outra arquitetura, permanece fora do commit.

- Código instalado de `@discordjs/voice@0.19.2`, AudioPlayer/AudioResource e
  receive/decriptação; lockfile preservado.
- [Documentação oficial AudioPlayer](https://discord.js.org/docs/packages/voice/0.19.0/AudioPlayer%3AClass)
  e [recursos de áudio](https://discordjs.guide/voice/audio-resources).
- [Rate limiting oficial da Brave](https://api-dashboard.search.brave.com/documentation/guides/rate-limiting).
- Regressões: `tests/playback-errors.test.ts`, `tests/playback.test.ts`,
  `tests/bot-command-errors.test.ts`, `tests/agent-turn.test.ts`,
  `tests/voice-receiver.test.ts`, `tests/bot-v5.test.ts`,
  `tests/game-search.test.ts` e `tests/latency-analysis.test.mjs`.
