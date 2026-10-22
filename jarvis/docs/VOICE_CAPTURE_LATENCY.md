# Captura, duplicação e latência — V5

Atualização V5.2: o padding sintético descrito abaixo agora desconta somente
amostras digitais exatamente zero já presentes no final do PCM convertido.
Nenhuma amostra capturada é removida. A combinação termina com pelo menos 800 ms
de zeros, arredondando o padding para cima em frames de 20 ms. Fala baixa e ruído
não contam como silêncio digital. `silence_tail_ms` informa o padding real e
`agent_input_silence_saved_ms` mede o padding evitado; isso não comprova ganho
acústico no Render. Veja o [roteiro atual](V52_PRODUCTION_VALIDATION.md).

Esta revisão protege a entrega de uma mesma captura; não comprova que a causa
única das duplicações em produção fosse o Discord emitir segmentos sobrepostos.
Os eventos existentes não continham identificadores de captura suficientes para
demonstrar essa hipótese. Também não deduplica pelo conteúdo da pergunta: repetir
uma pergunta intencionalmente continua permitido.

## Proteção por captura

O receptor gera um identificador opaco com contador crescente por instância e
anexa início/fim medidos no relógio monotônico local. Esses identificadores não
são enviados ao ElevenLabs nem aparecem nos logs. Enquanto uma captura está
ativa, novos eventos `speaking.start` do mesmo Discord ID são agrupados no mesmo
buffer. Microgaps menores que os 600 ms de VAD existentes não criam outra pergunta.
Não foi acrescentado um cooldown temporal às perguntas normais.

Antes do reconhecimento de wake word, o gerenciador descarta entregas com o mesmo
identificador ou com uma janela temporal positivamente sobreposta a uma janela
já observada. A chave é Discord ID + versão de consentimento + canal. Janelas
adjacentes e conteúdo PCM idêntico em capturas novas são independentes, inclusive
durante a janela de follow-up. O histórico guarda somente metadados por até
120 segundos, com no máximo 16 participantes e 16 janelas por participante.
Revogação, saída e encerramento limpam o histórico correspondente. Os limites
impedem crescimento contínuo; não constituem uma garantia de deduplicação de
replays mais antigos que o histórico limitado.

`voice_capture_start_debounced` conta notificações agrupadas pelo receptor.
`voice_capture_duplicates` conta entregas descartadas antes de STT e orçamento.
Uma duplicata não produz notificação de fila nem uma nova mensagem de erro.
`voice_queue_rejected` conta a rejeição de uma captura distinta por limite;
o erro mantém `code=limit` e distingue fila global, fila individual, memória e
orçamento. O cooldown de dois segundos da interrupção autorizada do proprietário
foi preservado; ele limita verificações pagas e não se aplica às perguntas normais.

## Upload e protocolo

A [API WebSocket oficial](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket)
define `user_audio_chunk` como entrada de áudio e `user_transcript` como
reconhecimento da fala. O Jarvis preserva PCM na taxa negociada; não converte a
transcrição da wake word em uma pergunta escrita. A pergunta inteira, inclusive
o trecho após “Jarvis”, segue para o ElevenAgents. A transcrição final do provedor
continua obrigatória para autorizar a resposta e separar a saudação inicial.

O envio atual começa depois da captura, da detecção de wake e da espera na fila.
Cada frame representa 20 ms e é seguido por pacing de 20 ms. Depois do PCM
capturado há 800 ms adicionais de silêncio para o VAD do provedor. Assim, uma
pergunta longa pode consumir aproximadamente sua própria duração novamente no
upload, além das outras etapas. Isso é uma consequência do código, não uma
medição do Render. Os novos contadores `agent_input_source_chunks` e
`agent_input_silence_chunks` distinguem o PCM capturado desse silêncio adicional;
`agent_audio_upload_ms` e `upload_ms` medem o tempo efetivo do upload completo.

A [documentação de entrada](https://elevenlabs.io/docs/eleven-agents/customization/events/client-to-server-events)
permite chunks de áudio, mas não estabelece que acelerar arbitrariamente um
buffer gravado preserve a decisão de fim de fala em qualquer agente. Nesta
revisão o pacing e o silêncio final foram preservados. A [configuração de fluxo
conversacional](https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow)
também influencia a tomada de turno. Uma alteração de ritmo exigiria medir
reconhecimento, truncamento e respostas prematuras no agente publicado.

Uma futura entrada incremental pode sobrepor captura, wake e abertura de sessão,
mas precisa primeiro de um buffer de pré-ativação limitado, wake incremental
cancelável, regras para áudio capturado enquanto outro participante é atendido e
um teste de revogação em cada estágio. Abrir um provedor para todo ruído antes de
reconhecer wake também aumenta custo. Nenhuma dessas mudanças foi ativada sem
baseline ou substituindo a inteligência/voz do ElevenAgents.

## Medição real

Para cada pergunta, correlacione pelo incidente local os logs de captura, wake,
fila, sessão, input enviado, reconhecimento, primeiro áudio, primeiro pacote
reproduzido e disponibilidade da próxima pergunta. Meça separadamente sessão
nova e reutilizada. Não some tempos cumulativos como se fossem etapas exclusivas.
Os campos `capture_wait_ms` e `end_detection_ms` vêm do receptor; `upload_ms`
mede somente envio. Compare cinco perguntas equivalentes antes/depois, com
criador e convidado, e registre duração e percepção audível sem gravar conteúdo
privado. Os testes automatizados verificam a medição com relógio sintético;
não demonstram latência abaixo de dois segundos em produção.
