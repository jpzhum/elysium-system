# Investigação por isolamento — 25/10/2026

Nota de 26/10: a execução descrita abaixo é histórica. O ensaio foi ampliado
para 20 tons/20 textos na [auditoria forense](FORENSIC_RELIABILITY_AUDIT.md),
que documenta as correções posteriores e os gates atuais.

Base examinada: `f8b8a5d` (inclui o P0 `7355ba9`). Node 24.19.0, npm 11.17.0,
dependências já instaladas e fixadas no lockfile. Não houve desenvolvimento de
funcionalidade, refatoração, troca de dependência, aumento de timeout, push ou
deploy. Nenhum módulo de produção foi alterado nesta investigação.

## Estado de aprovação

**O critério de aprovação em produção continua pendente.** Os handlers locais
de texto e reprodução passaram repetidamente; isso não equivale a audição nem a
respostas úteis numa chamada real. Não há evidência nova que autorize atribuir a
experiência inutilizável a um componente específico ou modificar sua implementação.

Não havia processo Node/worker ativo no ambiente examinado, `.env` local do
Jarvis ou credenciais Discord/ElevenLabs nas variáveis pertinentes do shell.
Não foi possível conectar à instância Render, executar slash commands reais ou
ler seus logs. Nenhum serviço foi iniciado com credenciais fictícias. O ensaio
abaixo instancia o bot em teste, sem login no Discord e sem chamadas pagas.

### Incidentes solicitados

| Incidente real | Evidência disponível | Primeiro componente que falha |
| --- | --- | --- |
| `4C09D8B0` | ID informado; nenhum evento correspondente encontrado no repositório ou nos anexos locais disponíveis. SHA/horário/processo desconhecidos. | Indeterminado. |
| `B4C09469` | ID informado; nenhum evento correspondente encontrado no repositório ou nos anexos locais disponíveis. SHA/horário/processo desconhecidos. | Indeterminado. |

Esses IDs não foram usados em eventos sintéticos. Para correlacioná-los, é
necessário recuperar os eventos reais por ID e o SHA implantado, preferencialmente
antes de reiniciar o worker. `/jarvis status incidente:<ID>` mantém somente os
últimos 64 incidentes do processo; se o registro foi perdido, os logs do serviço
são necessários. O SHA local não foi tratado como SHA implantado.

## Ensaio único com estado preservado

`tests/fault-isolation.test.ts` executa as quatro fases dentro de **um único
teste**. Cria uma vez JarvisBot, cliente Discord sem login, VoiceConnection nativa
da biblioteca fixada, VoiceConnectionManager, AudioPlayer, PlaybackQueue,
SessionManager, VoiceReceiver, detector wake e memória. As identidades desses
objetos são verificadas após cada interação. Não há `/leave`, reconstrução de
room, limpeza de cooldown ou reinicialização entre fases.

O participante de texto mantém consentimento sem áudio. Para a terceira fase,
um segundo participante, antes não consentido, concede áudio. Isso preserva o
consentimento, a sessão e a memória do participante de texto. Expiração de
sessão ociosa, cancelamento por conexão indisponível e renovação posterior seguem
o ciclo real dos componentes, sem substituir o manager ou zerar seu estado.

Fronteiras controladas: guild/interações Discord, adaptador gateway, transporte
de voz e endpoints/websocket ElevenLabs. A implementação do adapter ElevenAgents,
PCM, encoder/decoder Opus, recursos, player, conexão e coordenação do bot são
reais. O relógio é virtual; o hook existente de pacing mantém os mesmos 20 ms
por bloco, em vez de misturar o relógio real de `node:timers/promises` com timers
virtuais. Nenhum prazo da aplicação foi modificado.

| Fase | Execução local | Resultado / limite |
| --- | --- | --- |
| 1 | Dez chamadas ao handler de `/jarvis tone`, mesmo player e conexão. | Dez concluídas; pacotes preparados e despachados no transporte controlado. Zero conexões ElevenAgents, STT ou assinaturas de captura. Audição real pendente. |
| 2 | Dez perguntas ao handler de `/jarvis ask`, consentimento sem áudio. Eventos speaking-start são tentados para verificar o bloqueio de captura. | Dez turnos concluídos, com incidente, terminal e liberação únicos. Zero STT/captura; Buffering/Playing/Idle e drain local observados. Backend do provedor controlado. |
| 3 | Captura e Opus reais, erro de stream DAVE e pacote inválido separados, recuperação da captura seguinte; detector wake independente do ElevenAgents. | Três capturas válidas, duas falhas provocadas e contidas. Cooldowns 10/20/40/60 s respeitados. Sessão Davey nativa criada/resetada; **negociação MLS, criptografia e decriptação reais não verificadas**. |
| 4 | Vinte turnos alternados: dez escritos e dez de voz sintética; todos os componentes locais integrados no mesmo worker de teste. | Vinte concluídos, nenhum terminal duplicado ou erro de turno. Inclui callbacks antigos, Ready→Connecting→Ready e remoção explícita de assinatura. Transporte/provedor controlados. |

Uma pergunta escrita adicional durante o cooldown da fase 3 também conclui.
Total do ensaio: 31 turnos de perguntas concluídos/liberados uma vez e dez tons.
Não se contam as falhas provocadas de entrada como perguntas concluídas. A fase
4 respeita a janela existente de follow-up e o orçamento STT, avançando o relógio
sem limpar o histórico de admissão.

## Primeiro erro versus consequências

Nenhuma falha espontânea de produção foi reproduzida no ensaio. Os controles
negativos mostram onde a cadeia para quando uma falha conhecida é introduzida:

| Controle | Primeiro componente observado | Consequências observadas |
| --- | --- | --- |
| Erro `DecryptionFailed` injetado no stream de entrada | Fronteira de recebimento, `receive_stage=stream`, `DAVE_DECRYPTION_FAILED`, sem PCM. | Captura encerrada, sem STT nem pergunta ao agente; próxima captura válida. É teste de classificação/contenção, não falha criptográfica real. |
| Pacote Opus vazio | Decoder, `receive_stage=decode`, `OPUS_DECODE_FAILED`. | Sem entrega parcial ao wake/agente; stream removido; próxima captura válida. |
| Falas reconhecidas sem wake | Política de admissão por participante, após respostas negativas do STT controlado. | Pausa progressiva somente na voz. Rejeições não compram STT nem estendem o prazo. Texto continua funcionando. |
| Erro/completion de socket fechado, erro de recurso destruído e AudioPlayerError de recurso antigo | Eventos tardios pertencem a recursos antigos. | Não alteram o turno atual, não criam falso sucesso/falha nem aviso duplicado. |
| Ready→Connecting→Ready | Conexão torna-se temporariamente indisponível. | Sessões são encerradas conforme contrato; mesmo manager/conexão/player retornam disponíveis e o próximo turno funciona. Assinatura normal é preservada. |
| Assinatura explicitamente removida | Registro da conexão/player ausente. | Reparado pelo P0 já existente; próximo turno funciona. Não prova que isso ocorreu nos incidentes reais. |

O aviso “áudio recebido, reprodução não começou” é uma consequência terminal:
PCM chegou, mas não foi observado primeiro pacote local. `PLAYBACK_FAILED` e
Idle após limpeza também podem ser consequências. Para chegar à causa, é
necessário o primeiro erro técnico e seu estágio **antes** da limpeza, na mesma
sequência de incidente. Não se atribui falha de texto a cooldown de wake ou
decoder de entrada apenas porque esses subsistemas também apresentam erros.

### Cooldown e recursos após término

O cooldown é verificado imediatamente e novamente um segundo depois: o restante
diminui, sem nova requisição STT. O ensaio espera o `retryAt` existente e testa
nova admissão; a pausa não cresce por tentativas bloqueadas. Texto conclui durante
essa pausa. Não foi demonstrado bloqueio global de texto pelo cooldown.

Após cada reprodução/pergunta, o teste verifica fila liberada, player Idle,
buffers zerados, recursos destruídos, captura e checking vazios, assinatura
correta e identidade dos componentes preservada. Listeners não crescem. Sessões
abertas são limitadas a dois participantes e correspondem ao `activeCount`.
Uma sessão quente pode continuar aberta com heartbeat, prazo de vida e idle;
isso é reutilização deliberada, não prova de vazamento. Os timers permanecem
limitados durante o ensaio e chegam a zero no shutdown final real do cliente.

As antigas correções de drain e assinatura estão documentadas em
[P0 de playback](P0_OUTPUT_PLAYBACK_RELIABILITY.md). Nesta investigação, não foi
demonstrada causa nova que justifique outra alteração de produção. O commit
adiciona o ensaio e a documentação, sem afirmar correção dos dois incidentes.

## Regressão executada

- Ensaio individual das quatro fases: aprovado.
- Suíte completa: **752 testes aprovados em 40 arquivos; um gate real ignorado**.
- Typecheck, lint, build e `git diff --check`: aprovados.
- O gate ignorado exige humanos, negociação DAVE/MLS, reconexão e audição no Discord.

Reprodução local, em `jarvis/`:

```console
npm test -- tests/fault-isolation.test.ts
npm run typecheck
npm run lint
npm test
npm run build
```

## Teste real necessário, com aprovação por etapa

Use **o mesmo processo do worker**, registrando SHA implantado, início e tempo
ativo. Não reinicie entre tentativas ou para fazer um erro desaparecer. Uma
reconexão deve ser anotada como evento do ensaio. Mantenha memória, orçamento e
cooldown; respeite o prazo informado em vez de revogar/reconsentir para zerá-lo.

1. **Saída isolada:** criador executa dez `/jarvis tone` sequenciais, sem chamar
   ElevenLabs. Para cada um, anotar incidente, audição do tom completo, estados,
   assinatura e duração. Se qualquer tom falhar, interromper o avanço de fase e
   investigar a saída Discord antes de envolver o agente.
2. **Texto:** consentimento sem áudio; captura efetivamente bloqueada para todos
   os participantes do teste. Executar dez `/jarvis ask` escritos sequenciais,
   esperando cada turno encerrar e respeitando a quota configurada. Registrar
   incidente e confirmação humana da resposta completa. Conferir que as métricas
   de captura/STT não crescem. Se falhar, preservar o processo e os logs e não
   reativar voz. **Somente texto e reprodução repetidos aprovam o avanço.**
3. **Entrada isolada:** após aprovação de 1/2, em ambiente de diagnóstico,
   receber voz consentida com encaminhamento ao ElevenAgents desligado. Testar
   captura/Opus com áudio sintético conhecido, chegada de usuários antes/depois
   do bot, prontidão e transições MLS/DAVE, captura após reconexão; testar STT/wake
   separadamente, medindo as pausas sem realizar perguntas ao agente. O modo
   `smoke:dave` existente pode ser iniciado para um ensaio **separado**, mas não
   permite `/ask` nem troca de modo no mesmo processo; portanto não satisfaz
   sozinho a sequência completa pedida. A disponibilidade de um roteamento de
   diagnóstico seguro na instância real deve ser estabelecida antes desta fase.
4. **Integração:** somente após as anteriores, vinte interações consecutivas na
   mesma instância, registrando ordem, tipo, incidente, resposta audível, estado
   final e efeitos da próxima tentativa. Não inserir falhas em produção por
   comandos improvisados; controles de falha já estão no ensaio local.

O acesso real e o encaminhamento controlado da fase 3 não estão disponíveis neste
ambiente. Não foi introduzido um novo modo/comando em produção para contornar
essa limitação. As fases reais não foram declaradas executadas.

### Coleta para `4C09D8B0` e `B4C09469`

No processo que os gerou, consultar `/jarvis status incidente:4C09D8B0` e
`/jarvis status incidente:B4C09469`. Nos logs, filtrar o campo `incident` por cada
ID e manter a ordem temporal. Recuperar SHA/horário de início para evitar misturar
processos com histórico diferente. Se a conexão foi reiniciada, incluir eventos
de recuperação relacionados, sem confundir o ID do join com o ID da pergunta.

Conferir a sequência: aceite/dispatch → sessão pronta → entrada concluída (se
voz) → PCM recebido → stream/recurso → `play_called` → Buffering/Playing →
primeiro pacote local → primeira exceção → Idle/settled → terminal/liberação.
Preservar tipo/código/estágio originais sanitizados e distinguir snapshot anterior
à falha de snapshot da limpeza. Se houve timeout, identificar qual relógio o
disparou e o último progresso anterior; não aumentar seu valor por tentativa.

Registrar somente metadados técnicos. Não copiar áudio, transcrição, pergunta,
resposta, tokens, ambiente completo ou URLs assinadas. Leitura/preparação/despacho
local de pacote não substituem confirmação de criptografia, UDP e audição real.
