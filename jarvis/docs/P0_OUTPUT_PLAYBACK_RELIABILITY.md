# P0 — PCM recebido, reprodução não iniciada

25/10/2026. Implementação local: `7355ba9`. Base: `baba1c9`.

## Conclusão e limite da evidência

O relato `/consent` → `/ask` escrito → “O agente enviou áudio, mas a
reprodução não começou” é evidência do caminho de saída. Ele não exige captura
de microfone e não permite atribuir a falha ao decoder Opus de entrada.

Foram reproduzidos e corrigidos dois defeitos locais: assinatura perdida ou
sem registro efetivo no player não era reparada; a limpeza de um recurso podia
contar pacotes descartados como início e drain bem-sucedido.

**A causa do incidente histórico em produção ainda não está comprovada.** Não
foram fornecidos seu ID, SHA implantado ou logs correlacionados. Perda da
assinatura foi provocada explicitamente nos testes. Reconexões normais preservam
a assinatura na biblioteca instalada; não se afirma que toda reconexão a perde.
Nenhuma chamada real, audição humana ou validação UDP/DAVE foi executada nesta
revisão. Nenhum push, deploy ou alteração remota foi feito.

## Condição exata do aviso

`JarvisBot.turnNotice()` usa essa frase para uma notificação `failed` com
`delivery === 'not_started'`. `SessionManager.delivery()` escolhe `not_started`
quando recebeu áudio (`audioBytes > 0`), mas `firstPlaybackAt` continua ausente.
O timestamp depende de `PlaybackQueue` emitir `first_packet`.

O aviso é uma classificação terminal, não o diagnóstico de um timeout específico.
Não existe watchdog curto de início. O manager tem inatividade de resposta de
45 s e a fila tem prazo absoluto padrão de 180 s por recurso, incluindo espera
e intervalos de geração. Nenhum prazo foi aumentado. Um teste do manager simula
playback ainda pendente por 45 s, após receber PCM e conclusão, sem inventar
início ou falha; uma falha posterior antes do primeiro pacote resulta em
`not_started`. As sequências com AudioPlayer real verificam Buffering separadamente.

Fluxo examinado: callback `onAudio` do adaptador ElevenAgents → manager →
`startStream/write` → conversão PCM incremental → OpusScript 48 kHz estéreo →
`GuardedStream` → `AudioResource` Opus → `AudioPlayer.play()` → player inscrito
na `VoiceConnection` → preparação/despacho do transporte Discord.

## Defeitos comprovados localmente

### Assinatura ausente ou registro obsoleto

A fila guardava somente a assinatura obtida no construtor. Caso a assinatura
fosse removida, uma conexão Ready podia continuar sem receber o player. Com
`NoSubscriberBehavior.Pause`, o player podia ficar AutoPaused sem consumir áudio
até outro encerramento ou prazo absoluto.

Agora a fila verifica a assinatura ao aceitar um stream, antes de `play()` e
quando a conexão volta a Ready. Verifica o par conexão/player e, na biblioteca
real, a presença da conexão em `AudioPlayer.playable`. Repara assinatura ausente
ou registro próprio obsoleto; rejeita assinatura de outro player com
`PLAYBACK_SUBSCRIBE_FAILED`. Não substitui uma assinatura estrangeira.

Testes reproduzem ausência em Ready, perda em reconexão e ponteiro próprio sem
registro efetivo. Todos voltam a consumir áudio; assinatura estrangeira falha
explicitamente. A fonte examinada é a dependência local fixada
`@discordjs/voice@0.19.2`, em `VoiceConnection.subscribe()` e
`AudioPlayer.subscribe()`. Não houve atualização de dependências.

### Pacote descartado na limpeza contado como playback

Ao substituir/encerrar o recurso, o setter de estado do AudioPlayer instalado
executa `playStream.destroy()` e depois `playStream.read()`, antes do callback
Idle. Um pacote já codificado e ainda no buffer podia passar pela contagem de
`first_packet` durante essa limpeza. O Idle antigo considerava suficiente o
encoder ter terminado, mesmo com pacotes não consumidos pelo scheduler.

`GuardedStream.read()` agora ignora leituras após destruição. Idle só conclui
com sucesso quando houve primeiro pacote, o encoder terminou e todos os pacotes
codificados foram consumidos. O teste usa o AudioPlayer instalado, termina a
codificação sem agendar leitura e interrompe o player: exige
`PLAYBACK_PREMATURE_IDLE`, zero pacotes consumidos e ausência de sucesso/início.

Esse defeito produzia falso início/sucesso local. Ele não prova a origem do aviso
`not_started` relatado, que é um resultado diferente.

## Correlação e diagnóstico sanitizado

`/ask` aceito/enfileirado, seus avisos posteriores e o resultado de `/tone`
incluem o ID de oito hexadecimais do incidente. Consulte
`/jarvis status incidente:<ID>` antes de reiniciar. O status mostra o SHA Render,
campos atuais, a primeira exceção de playback sanitizada e até 16 etapas
(primeiras oito/últimas oito). A retenção é somente RAM, até 64 incidentes; os
logs estruturados permitem recuperar a sequência completa. Respostas longas
são paginadas, privadas e sem menções.

O mesmo incidente correlaciona `jarvis_agent_first_audio`, `jarvis_playback_state`,
`jarvis_playback_failed` e o terminal/liberação do turno. `playback_token`
identifica o recurso dentro do processo. As fases incluem `stream_accepted`,
`subscribed`, `pcm_accepted`, `resource_created`, `play_called`, `readable`,
`packet_read` e `settled`, além das transições de estado do player.

Cada snapshot inclui contagens PCM/pacotes, estado do player/conexão, assinatura,
disponibilidade DAVE e flags do recurso, quando observáveis. `pcm_accepted` e
`packet_read` são emitidos somente na primeira ocorrência por recurso; os totais
continuam nos snapshots finais. Bytes aceitos pela fila são contabilizados após
a escrita terminar: uma falha síncrona em `play()` pode mostrar zero aceitos,
embora o manager já tenha registrado PCM recebido.

| Evidência | Interpretação / próximo exame |
| --- | --- |
| `PLAYBACK_ENCODER_FAILED`, `opus_init`/`opus_encode` | Falha do encoder; consultar tipo original e código Opus sanitizados. |
| `PLAYBACK_RESOURCE_ENDED` / `PLAYBACK_RESOURCE_IN_USE` | Recurso encerrado ou pertencente a outro player; não reutilizar. |
| `PLAYBACK_SUBSCRIBE_FAILED`, `subscribed=false` | Falha na assinatura; conferir conexão/player e sequência de recuperação. |
| Buffering, nenhum `readable`/pacote | Recurso aguardando dados/encoder; cruzar chegada PCM, exceção e estado do stream. |
| Playing, zero `consumed_packets` | Transição de estado não basta para afirmar que frames foram consumidos. |
| `PLAYBACK_PREMATURE_IDLE`, consumidos < codificados | Recurso terminou com tail descartado; não contar como drain. |
| `PLAYBACK_DEADLINE` | Prazo absoluto alcançado; examinar etapas anteriores, sem presumir encoder ou DAVE. |
| Ready/Playing com `dave_ready=false` | Há uma condição de DAVE a investigar; não comprova que ela causou o incidente. |
| `packet_read` e contadores iguais | Consumo local; ainda falta prova de envio/audição no Discord. |

A exceção preserva somente classificações revisadas: `code`, `cause_code`,
`cause_name`, código numérico Opus, estágio e snapshot técnico anterior à
limpeza. Mensagem bruta, stack, URL assinada, token, PCM, texto da pergunta e
resposta não são registrados. `settled` e o rollup do manager não apagam essa
primeira exceção.

Na implementação DAVE instalada, `encrypt()` pode devolver o pacote original
quando o protocolo é zero, a sessão ainda não está pronta ou o frame é silêncio.
Ready, Playing e leitura local não atestam criptografia nem audição. Não foi
adicionado um bloqueio DAVE ou instrumentação privada de rede sem evidência do
incidente real.

## Testes e gates executados

Baseline: 740 testes aprovados, 38 arquivos e um gate real ignorado.
Resultado final: **751 testes aprovados, 39 arquivos e um gate real ignorado**.
Typecheck, lint, build e `git diff --check` aprovados.

`tests/output-endurance.test.ts` mantém o mesmo player/fila/conexão por sequência,
com AudioPlayer/AudioResource, conversão PCM, encoder Opus e adapter reais.
Somente websocket e fronteira de transporte Discord são controlados. O decoder
usado pelo teste valida os pacotes Opus de saída; não captura microfone.

| Sequência de 20 | Falha no terceiro | Falha no quarto | Resultado |
| --- | --- | --- | --- |
| Perguntas escritas, mesmo SessionManager, consentimento sem áudio | Encoder antes do primeiro pacote | Transporte do provedor após pacotes | 18 concluídas, uma falha `not_started`, uma parcial; 19 drains locais, 18 entregas, dois avisos de falha, 20 terminais/liberações únicos. |
| Tom idêntico ao `/jarvis tone`, sem ElevenLabs | Encoder | Erro do player após início | 18 concluídos, duas falhas; 20 encerramentos únicos. |

O quinto turno recebe erros tardios de socket/recurso/player antigos e prossegue.
Após a quarta pergunta, uma reconexão com perda explícita da assinatura testa a
reparação. Contadores de buffer voltam a zero, recursos/codecs/tasks são limpos,
listeners não crescem e perguntas falhas não entram na memória. Não há STT,
captura, rede externa ou consumo pago. Preparação e despacho de pacotes são
contados separadamente **no transporte controlado**.

Reexecução, em `jarvis/`:

```console
npm run typecheck
npm run lint
npm test
npm run build
npm test -- tests/output-endurance.test.ts tests/playback-errors.test.ts tests/agent-turn.test.ts tests/bot-v5.test.ts tests/operational-evidence.test.ts
```

## Roteiro de aceitação no Discord real — pendente

1. Registrar o SHA efetivamente implantado e o horário/processo do teste. Esta
   revisão não publica nem reinicia o serviço. Não executar em `smoke:dave` para
   a sequência de `/ask`, pois esse modo desativa o provedor.
2. Entrar em um canal de voz e executar `/jarvis join`. Manter o microfone mudo,
   executar `/jarvis consent` sem áudio e confirmar que a captura não foi
   autorizada. Não conceder consentimento de áudio durante essa sequência.
3. Executar `/jarvis tone` pelo criador. Confirmar a audição do tom e consultar
   seu incidente no status. Repetir 20 vezes, aguardando o encerramento de cada
   reprodução na mesma instância; registrar audição, estados, assinatura e DAVE.
   O tom não chama ElevenLabs. Se falhar, priorizar a saída Discord.
4. Executar `/jarvis ask texto:<pergunta curta>` por 20 turnos na mesma instância,
   aguardando cada resposta e respeitando a cota configurada. Usar perguntas sem
   dados privados e registrar apenas números de turno, incidentes e resultados.
   Confirmar audição e ausência de repetição/truncamento; não inferir isso de
   `Playing`. Os erros 3/4 já foram injetados localmente; não há comando novo de
   injeção em produção. Qualquer falha real deve ser seguida por nova pergunta
   para verificar recuperação.
5. Para cada falha, consultar imediatamente `/jarvis status incidente:<ID>` e
   guardar somente os campos técnicos sanitizados daquele incidente nos logs.
   Cruzar PCM recebido, assinatura, recurso, `play_called`, Buffering/Playing/Idle,
   exceção, contagens codificadas/consumidas, outcome e liberação única. Informar
   se `/tone` foi audível na mesma conexão. Não enviar áudio, transcrições,
   URLs assinadas ou segredos.
6. Em janela de manutenção, observar uma recuperação de voz controlada sem
   reiniciar o processo. Após Ready, repetir tom e pergunta; confirmar assinatura
   na conexão atual e ausência de replay de resposta anterior. Se a conexão for
   destruída, executar `/join` para criar uma nova sala lógica antes do teste.
7. Conferir identidade, voz existente, consentimento, memória consentida e uma
   pesquisa Brave em uma pergunta curta. Esses contratos não foram modificados.
   Validar também ausência de aviso duplicado ou falso sucesso depois de erro.

Aprovação exige áudio ouvido nos dois caminhos e logs correlacionados, inclusive
após recuperação. Até lá, o status desta entrega é **correções locais validadas;
incidente de produção e aceitação audível pendentes**.

## Arquivos e reversão

- `src/audio/playback.ts`: assinatura, guard de destruição, drain e etapas.
- `src/observability/metrics.ts`: allowlist de metadados de saída.
- `src/observability/operational-evidence.ts`: histórico limitado e exceção original.
- `src/discord/bot.ts`: incidente visível e status privado paginado.
- Testes: `playback-errors`, `agent-turn`, `output-endurance`, `bot-v5`,
  `operational-evidence`; o double de `conversation-endurance` passou a modelar
  conexão/player de uma assinatura real.

Sem mudanças de voz, agente, prompt, consentimento, memória, Brave, dependências,
variáveis de ambiente ou Elysium Python. Não foi criada persistência externa.
Rollback do código: reverter `7355ba9` após revisão, ou usar `baba1c9` no serviço
quando houver autorização de implantação. Nenhum rollback foi executado.
