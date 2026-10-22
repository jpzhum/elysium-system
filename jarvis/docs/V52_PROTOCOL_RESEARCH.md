# V5.2 — Eventos ElevenAgents e continuidade

Consulta realizada em 22/10/2026. `npm view @elevenlabs/client version`
retornou `1.30.0`; o `package.json` do repositório oficial consultado informa
a mesma versão. O Jarvis continua usando seu adaptador WebSocket Node com
controle de fluxo, sem instalar o SDK de navegador ou alterar o protocolo de
entrada. [Pacote oficial](https://github.com/elevenlabs/packages/blob/main/packages/client/package.json).

## O que cada sinal comprova

`user_transcript` contém uma fala reconhecida final. `agent_response` contém
uma mensagem textual completa; em conversas por voz ela normalmente chega
depois que o áudio começou a ser transmitido. `audio` fornece blocos para
reprodução progressiva. Essas definições permitem histórico textual, mas não
demonstram que todo o PCM chegou ou foi ouvido.
[Client Events](https://elevenlabs.io/docs/eleven-agents/customization/events/client-events).

O `BaseConversation` do SDK encaminha o texto final e seu `event_id`, além
de `response_id` quando presente. Trata a correção em callback separado, com
`corrected_agent_response`; deltas de chat usam outro evento. O dispatcher
consultado não contém um handler específico para `agent_response_complete`.
Isso não prova que o provedor deixou de suportar o evento.
[BaseConversation](https://github.com/elevenlabs/packages/blob/main/packages/client/src/BaseConversation.ts).

O SDK de voz entrega áudio sem aguardar um evento de conclusão. Usa
`event_id` como fronteira de interrupção: vários chunks podem pertencer ao
mesmo ID. Seu estado de reprodução muda com eventos locais do player.
Portanto ID repetido não é evidência de PCM duplicado e fila local vazia
não é confirmação de geração concluída.
[VoiceConversation](https://github.com/elevenlabs/packages/blob/main/packages/client/src/VoiceConversation.ts).

A referência oficial de configuração ainda lista
`agent_response_complete` como evento opt-in em `client_events`, emitido ao
terminar a resposta. Também lista `context_usage` após um turno completo.
Não se habilitou nem passou a depender desse segundo evento nesta atualização.
[Configuração oficial](https://github.com/elevenlabs/skills/blob/main/agents/references/agent-configuration.md).

Para restaurar memória curta, `contextual_update` é o evento documentado que
acrescenta informação de contexto sem iniciar uma pergunta. `user_message`
é uma entrada do usuário que inicia o fluxo de resposta; trocar áudio por
esse evento apenas para contornar ASR alteraria a integração. A V5.2 mantém
as entradas reais atuais.
[Client-to-server Events](https://elevenlabs.io/docs/eleven-agents/customization/events/client-to-server-events).

## Causas demonstráveis no código anterior

O adaptador já possuía um case de `agent_response_complete`; ele exigia o
envelope `agent_response_complete_event.event_id`. Logo contagem zero de
eventos recebidos não pode ser atribuída exclusivamente a um parser ausente.
O teste independente fornecido pelo operador também não observou esse evento.
Sem acesso ao agente publicado e à sessão real, comportamento do provedor,
workflow, versão publicada ou ferramenta pendente continuam hipóteses.

O gerenciador anterior só mantinha um socket reaproveitável quando recebia
conclusão explícita. No caminho sem esse evento, uma nova pergunta podia
aposentar o turno após uma drenagem local; a sessão era fechada e substituída.
Isso explica como as métricas `agent_turns_superseded` e ausência de reutilização
podiam aparecer juntas mesmo havendo áudio válido. Não comprova, isoladamente,
que todas as 14 sessões da amostra seguiram esse caminho.

O watchdog de progresso contém uma janela de 45 segundos. Esperar por ela
sem áudio ou confirmação explica a escala do pior caso observado, sem provar
que o provedor levou 45 segundos para gerar uma resposta. Captura, STT,
fila, conexão, envio, primeiro PCM e player precisam ser medidos separadamente.

## Superfície de conteúdo privado da V5.2

O novo callback opcional `onConversationText` entrega exclusivamente:

- `user_final`: texto ASR final, depois do marcador de reconhecimento.
- `agent_final`: mensagem textual final; não confirma geração nem reprodução.
- `agent_correction`: correção separada, inclusive vazia para invalidar uma resposta.

O payload contém `text`, `truncated`, `eventId` e `responseId` opcionais.
Cada texto ocupa no máximo 4 KiB UTF-8 sem cortar caracteres; a fila desse
conteúdo tem orçamento próprio de 64 KiB, além dos limites existentes de PCM,
eventos e ferramentas. Apenas esse payload canônico é retido, nunca o envelope
inteiro. A ordem é a mesma dos blocos PCM, inclusive sob backpressure.

Os callbacks de métricas continuam sem conteúdo. Texto parcial, fala tentativa
e raciocínio interno não alimentam memória. Revogação/fechamento local descartam
entregas pendentes; falhas do callback geram somente um código fixo. O consumidor
de memória deve aplicar consentimento, escopo por participante e turno, orçamento
e condição de entrega; receber `agent_final` sozinho não autoriza gravar uma
resposta como concluída.

## Verificação real pendente

No Render, use o auditor existente para conferir agente publicado, ferramentas
e eventos, sem imprimir prompt, segredos ou transcrições. Durante chamada real,
compare contadores de eventos recebidos, ferramentas pendentes e drenagem local.
Verifique pergunta escrita e voz separadamente, duas perguntas consecutivas e
uma resposta longa com ferramenta. Registre apenas códigos, etapas, durações e
contagens. Uma sessão encerrada para recuperação permanece sem confirmação
remota; teste automatizado não comprova que alguém ouviu a resposta no Discord.
