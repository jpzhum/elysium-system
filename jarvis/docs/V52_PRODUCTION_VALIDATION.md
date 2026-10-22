# V5.2: validação de continuidade, turnos e personalidade

A revisão deve ser avaliada no worker Jarvis existente e em uma chamada real.
Build, testes com relógio controlado e um WebSocket de teste verificam contratos
do código; não demonstram que uma pessoa ouviu uma resposta correta ou que o
agente publicado recuperou a personalidade. Esta entrega não executa deploy,
cria serviço pago ou publica alterações no ElevenLabs.

O operador confirmou priorizar esta V5.2; a V6 de memória PostgreSQL fica para o
próximo ciclo. Nenhuma migration, chave de banco ou serviço externo é necessário.

## Arquivos da implementação

| Arquivos | Responsabilidade |
| --- | --- |
| `src/agents/recent-conversation.ts` | Contexto RAM, TTL, autoria, orçamento e limpeza. |
| `src/agents/elevenlabs-client.ts` | Callback privado de texto final/correção, com fila limitada e ordem preservada. |
| `src/agents/session-manager.ts` | Entrega confirmada/observada, recuperação, renovação por TTL, fila, padding e medições. |
| `src/discord/bot.ts`, `src/discord/commands.ts` | Integração do contexto, comandos privados e aviso de privacidade. |
| `src/agents/prompt-context.ts` | Contexto técnico menor, sem substituir personalidade ou autoridade. |
| `src/config.ts`, `.env.example` | Validação e exemplo da variável opcional de TTL. |
| `src/observability/metrics.ts`, `src/observability/status.ts` | Flags sem conteúdo e métricas completas de etapas. |
| `tests/recent-conversation.test.ts`, `tests/recent-conversation-integration.test.ts` | Novos testes de contexto, identidade, expiração, falhas e fluxo real adapter/manager. |
| `tests/agent-turn.test.ts`, `tests/multiuser.test.ts`, `tests/elevenlabs-client.test.ts` | Regressões de protocolo, sessões, entrega, fila e upload. |
| `tests/bot-v5.test.ts`, `tests/commands.test.ts`, `tests/config.test.ts`, `tests/observability.test.ts` | Contexto no bot, comandos privados, configuração e proteção de logs. |
| `README.md`, `IMPLEMENTATION_STATUS.md`, `docs/ELEVENLABS.md`, `docs/VOICE_CAPTURE_LATENCY.md`, `docs/VOICE_GREETING_VALIDATION.md` | Contratos operacionais atualizados. |
| Este guia, `docs/V52_PERSONALITY.md`, `docs/V52_PROTOCOL_RESEARCH.md` | Configuração, pesquisa oficial e validação humana. |

Não houve mudança em dependências, no prompt V3 original, no Python, no Blueprint
ou nas configurações remotas. Não é necessário instalar biblioteca adicional.

## Evidência e limites do diagnóstico

O diagnóstico fornecido pelo operador corresponde à versão anterior: 14 sessões
abertas e nenhuma reutilizada; nove turnos reconhecidos e nove respostas após
reconhecimento; 171 chunks recebidos e reproduzidos; nove playbacks completos;
nove turnos marcados como substituídos; 11 conclusões ausentes e nenhum
`agent_response_complete`; dois timeouts e dois erros. O tempo médio informado
até o primeiro áudio foi 13.104,7 ms, com pior caso de 45.031 ms.

Esses números comprovam reprodução e ausência observada do evento de conclusão.
Não correlacionam, sozinhos, todos os eventos à mesma pergunta nem provam que
nenhuma resposta terminou no provedor. “Playback completo” comprova o fim local
da reprodução daquele fluxo, não uma confirmação de toda a geração remota.

| Achado na implementação anterior | Consequência demonstrável | O que exige observação real |
| --- | --- | --- |
| A reutilização ocorria depois de conclusão explícita e drenagem. Sem o evento, a recuperação retirava o socket. | O desenho podia abrir uma sessão nova para a pergunta seguinte, mesmo depois de uma resposta audível. | A razão exata de cada uma das 14 sessões precisa do incidente e da versão implantada. |
| Uma pergunta nova, com áudio anterior drenado e sem ferramenta/upload pendente, podia retirar o turno antigo como `superseded`. | A métrica misturava recuperação de um turno sem confirmação com a ideia de substituição de pergunta. | Os nove incrementos não provam nove perguntas legítimas descartadas ou nove interrupções audíveis. |
| A espera de progresso tinha deadline de 45 segundos; recuperação por nova pergunta também exigia texto, mesmo com áudio drenado. | Sem texto final, uma saída audível podia manter a fila esperando o deadline. A V5.2 permite recuperação por áudio válido, com as demais guardas mantidas. | Um pico de 45.031 ms não identifica sozinho se houve ausência de ASR, áudio, conclusão ou falha de rede. |
| O contexto dependia da conversa presente na sessão ElevenAgents. | Abrir outro socket não transportava automaticamente as perguntas e respostas anteriores do Jarvis. | A interpretação correta de pronomes pelo agente publicado depende do conteúdo real e da validação humana. |
| A captura, STT de wake, fila, conexão e upload eram etapas sequenciais. | Perguntas longas e fila podiam acumular tempo antes da geração remota. | Nenhum ganho em segundos pode ser declarado sem comparar as mesmas condições. |
| O prompt original já continha personalidade, respostas breves e humor ocasional. | Não há prova local de substituição do prompt por uma versão formal. | É necessário conferir prompt publicado, workflows, voz e respostas ouvidas. |

Uma pausa entre chunks continua sem provar fim de geração. Uma recuperação pode
encerrar a entrada do provedor e drenar os pacotes já aceitos para liberar recursos
e atender a fila; ela deve continuar identificada como **sem conclusão remota
confirmada**. Não é permitido transformar essa condição em resposta completa na
memória, reproduzir dados de outro turno ou ignorar ferramentas pendentes.

Na V5.2, a recuperação por nova pergunta fica em `agent_turns_recovered` e no
evento `jarvis_agent_turn_recovered`, sem incrementar `agent_turns_superseded`.
Ela exige drenagem local observada, upload terminado e ausência de ferramenta ou
write pendente; o fechamento drena a entrada aceita antes do fim local do stream.
`turn_outcome: unconfirmed` permanece distinto de uma resposta completa. O deadline de
45 s continua limitado à falta de progresso; com áudio já recebido, esse caso
incrementa `agent_completion_recovery_timeouts`, e sem áudio mantém
`agent_response_timeouts`. Zero reutilizações pode ser compatível com a ausência
do evento, não um defeito isolado.

## Memória curta e privacidade

A memória fica em RAM na instância da sala atual, limitada a dez interações no
total. Cada entrada é vinculada internamente ao Discord ID e à versão de
consentimento de seu autor. A recuperação injeta **somente as interações do
próprio solicitante**, inclusive quando outra pessoa está na mesma chamada ou
possui o mesmo nome de exibição. Não há resumo de conversa da sala nem perfil
permanente de participantes.

Ao abrir uma sessão nova, o backend envia contexto relevante por
`contextual_update` antes da pergunta atual. Isso permite continuidade sem
depender da reutilização de WebSocket. O orçamento inclui prefixo e conteúdo:
até 2.400 caracteres e 4.096 bytes UTF-8; cada pergunta fica limitada a 600
caracteres e cada resposta a 900. Perguntas recortadas têm flag explícita;
respostas maiores ou que não caibam no orçamento são omitidas em vez de serem
apresentadas como respostas completas truncadas. Conteúdo ausente não pode ser inventado.

Uma resposta real só é armazenada como completa após conclusão explícita,
`stream.done` e ausência de falha. Sem confirmação de geração, a memória pode
preservar a pergunta real e o texto final observado do agente em campo separado
`agent_text_observed`, com `generation: unconfirmed`, **sem transportar esse texto
como resposta completa**. Ele permite reconhecer um item apresentado somente
pelo agente; não comprova que o participante ouviu toda a mensagem. Falha,
correção ou truncamento invalidam esse texto. Não se deve fingir que uma frase foi
entregue integralmente apenas porque chegaram chunks ou houve drenagem.

O TTL padrão é dez minutos. Expiração, revogação, saída, reset e shutdown limpam
as entradas correspondentes. `/jarvis context status` mostra o estado do contexto
do solicitante de forma privada; `/jarvis context clear` cancela seu turno/fila e
apaga somente suas próprias entradas, impedindo que a resposta antiga as recrie
tardiamente. Uma conta não pode usar esse comando para ler ou apagar o contexto
privado de outra.
O prazo não corta uma resposta ativa. Antes da próxima pergunta, um socket com
contexto vencido é fechado e substituído; o contexto expirado não é reinjetado.

O estado e a limpeza local não leem nem apagam o histórico retido pelo provedor.
Leia também `/jarvis privacy`; áudio, perguntas, respostas e transcrições não são
incluídos nas métricas ou logs. Não configure banco externo para esta memória.

## Preparação sem deploy

No checkout revisado, execute os comandos dentro de `jarvis/`:

```console
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Os resultados efetivamente executados constam em
[`IMPLEMENTATION_STATUS.md`](../IMPLEMENTATION_STATUS.md). Preserve o serviço
Elysium Python, DAVE, os intents e as permissões existentes. Nenhum teste deve
conectar ao Discord durante importação ou usar uma sala real automaticamente.

Revise no ElevenLabs o complemento mínimo de
[V52_PERSONALITY.md](V52_PERSONALITY.md). Não substitua o prompt original, a voz
ou as ferramentas por uma configuração genérica. Confira as quatro variáveis já
existentes e as Client Tools `get_voice_participants` e `search_game_info`, com
**Wait for response** e os schemas descritos em
[V5_AGENT_PROMPT.md](V5_AGENT_PROMPT.md). Nenhuma ferramenta fictícia de memória
ou variável sem backend deve ser cadastrada.

O contexto curto é enviado pelo backend como informação de apoio à conversa.
Ele não é a pergunta atual nem uma instrução de autenticação. Confira a versão
publicada do agente, inclusive os nós de workflow; o código local não comprova
seu conteúdo remoto.

No ambiente já configurado do operador, o comando somente de leitura é:

```console
npm run audit:agent
```

Esse comando exige build e configuração válida do worker. Confira
`configuration_checks_passed` e `manual_review_required`; `status: "ok"` sozinho
não significa contrato aprovado nem validação de comportamento.
`runtime_behavior_verified` é falso por definição nessa auditoria estática.
Não copie prompt, credenciais, URLs assinadas ou payloads para o registro.

## Render: aplicar somente quando autorizado

Use o Background Worker Jarvis existente, uma instância e a branch já conectada.
Não crie banco, disco pago, outro worker ou serviço novo para esta revisão de
memória em RAM. Preserve as variáveis e os limites operacionais já configurados,
incluindo `JARVIS_VOICE_INPUT=elevenlabs-stt` para entrada por voz e a chave Brave
existente `JARVIS_SEARCH_API_KEY` quando a pesquisa for utilizada.

Há uma variável opcional nova no **Environment do worker Jarvis**:

```dotenv
JARVIS_SHORT_MEMORY_TTL_SECONDS=600
```

O valor inteiro é expresso em segundos: `0` desabilita memória curta e o máximo
aceito é `1800`. Ausente, usa `600`; não é necessário configurar outra variável
para ativar o padrão. Preserve as variáveis do serviço Python. Nenhuma nova
variável dinâmica, Client Tool ou permissão de override é necessária para a
memória. Os comandos contextuais devem ser registrados pelo worker atualizado
junto dos comandos existentes; confirme sua presença depois da inicialização.

Quando o operador autorizar a publicação do código:

1. Envie o commit revisado para a branch conectada ao Render, por exemplo
   `git push origin main` se essa for a branch configurada.
2. No worker existente, faça deploy manual do SHA revisado. Preserve
   `Root Directory: jarvis`, build `npm ci && npm run build` e start
   `npm run start`.
3. Confira o SHA implantado e aguarde o processo anterior encerrar. Não execute
   duas instâncias com o mesmo bot para comparar versões.
4. Confira `jarvis_ready` com `diagnostics_version: 7` e execute a auditoria estática acima no shell do worker.
   Uma leitura bem-sucedida da configuração não substitui a matriz real abaixo.
5. Entre na chamada, execute `/jarvis join`, leia `/jarvis privacy` e renove o
   consentimento das duas contas. Só a presença no canal não permite captura.

A memória curta desta revisão é temporária: reinício, redeploy e expiração
eliminam seu conteúdo. Ela não substitui a retenção configurada na conta
ElevenLabs. Limpar dados locais não comprova apagar conversas remotas.

## Matriz de aceitação em chamada real

Use uma conta criadora e uma convidada com Discord IDs diferentes e consentimento
próprio. Faça uma rodada com nomes de exibição iguais. Registre apenas SHA,
versão do agente, incidente, tempos e resultados pass/fail. Os exemplos abaixo
são frases sintéticas para o teste, não conteúdo a ser colocado em logs.

| Teste | Procedimento | Resultado necessário |
| --- | --- | --- |
| Resposta simples | Diga “Jarvis, quanto é dois mais dois?” e ouça até o fim. | A pergunta é reconhecida; “quatro” é audível. Não conte uma saudação como resposta. |
| Continuidade com socket novo | Pergunte sobre uma arma específica; depois pergunte outra característica dela. Confira os contadores de sessão. | A segunda resposta usa o assunto real mesmo quando uma nova sessão foi aberta. Reutilizar socket não é obrigatório. |
| Referência pronominal | Pergunte sobre uma arma mencionada pelo próprio usuário e, em outra rodada, peça uma recomendação em que só o agente introduza o item; depois pergunte “Onde encontro ela?”. | Usa a referência real. Se vier de texto observado sem conclusão, não alega entrega integral anterior; pede esclarecimento se ambíguo. Pesquisa quando necessário, sem inventar localização. |
| Duas pessoas | As duas contas fazem perguntas distintas, inclusive uma enquanto a outra aguarda. | Autoria correta, uma resposta por vez e nenhum contexto privado transferido entre usuários. O criador só ganha prioridade entre perguntas aguardando. |
| Resposta longa e nova pergunta | Peça explicação longa; outra conta faz uma pergunta durante sua reprodução. | Nenhum pacote em andamento é cortado por um simples enfileiramento. A nova pergunta é atendida ou recebe motivo explícito de limite/cancelamento. |
| Sem conclusão explícita | Observe uma sessão em que o evento já esteja ausente, sem desabilitar eventos ou segurança. | Primeiro áudio começa normalmente; a fila fica utilizável pela política documentada e a recuperação não afirma geração completa. Áudio válido recebido não é descartado só por faltar o evento. |
| Conclusão explícita | Se o provedor enviar `agent_response_complete`, confira o mesmo turno até a drenagem. | Conclusão da geração, recepção e fim de playback não são confundidos. Reutilização pode ocorrer dentro dos limites configurados. |
| Duplicata da mesma captura | Confira uma ativação e sua confirmação de fila. Em seguida faça outra pergunta legítima, inclusive repetindo intencionalmente as palavras. | No máximo uma confirmação da mesma pergunta. Uma captura nova não é descartada por texto parecido. A posição representa a fila no momento da aceitação. |
| Falha do ElevenLabs | Em ambiente de teste controlado, provoque uma falha de conexão ou cancele a sessão. Não exponha chaves e não altere produção ativa para esse teste. | Erro sanitizado, fila liberada, sem áudio tardio e sem guardar uma resposta fracassada como completa. |
| Ferramenta pendente | Faça uma pesquisa real com Brave disponível e outra consulta em seguida. | Não se declara fim de geração enquanto a ferramenta está pendente. Sources reais ou indisponibilidade honesta; nenhuma resposta pronta substitui a pesquisa. |
| Revogação | Revogue o consentimento durante upload, playback e uma pergunta aguardando. | Envio e reprodução param; o usuário não reaparece pelo histórico removido e uma sessão antiga não pode continuar usando ferramentas. |
| Expiração e limpeza | Registre um assunto sintético, confira `/jarvis context status`, espere o TTL configurado e faça referência ambígua. Repita usando `/jarvis context clear` durante um turno e depois consulte o status. | O assunto expirado/apagado não é restaurado ao abrir outro socket; uma resposta tardia não o recria. Jarvis pede esclarecimento quando necessário. A outra conta mantém apenas seu próprio contexto. |
| Personalidade | Teste resposta objetiva, plano de jogo ousado, convidado e pedido carinhoso para Kel. | Português natural, “senhor” só quando apropriado, humor ocasional e respeitoso, nenhum deboche em pedido romântico. Use os critérios de V52_PERSONALITY. |

Não use os testes de erro para derrubar uma chamada ativa. Desconexão, suspensão
de consentimento e cancelamento podem ser verificados numa sessão de teste com
os mesmos limites e permissões. A comparação real deve incluir ouvir o Jarvis,
não apenas verificar `audio_chunks_played`.

## Latência: comparar a mesma operação

Faça pelo menos cinco perguntas equivalentes antes e depois, com a mesma versão
do agente, configuração de VAD, rede e condição de fila. Separe sessão nova e
reutilizada. Anote o intervalo percebido da última palavra até o primeiro áudio
audível e compare as etapas técnicas de `/jarvis status` pelo incidente:

| Etapa | Evidência técnica |
| --- | --- |
| Captura e fim de fala | `voice_capture_ms`, `voice_end_detection_ms` |
| Wake/STT | `wake_queue_wait_ms`, `wake_recognition_ms`, `wake_detection_ms` |
| Fila | `question_queue_wait_ms`, `turn_queue_depth` |
| Handshake e reaproveitamento | `agent_session_open_ms`, `agent_session_reused`, `session_reused` |
| Upload | `agent_audio_upload_ms`, `agent_input_source_chunks`, `agent_input_silence_chunks` |
| Padding de silêncio evitado | `agent_input_silence_saved_ms`; deduz somente zeros digitais exatos, nunca fala ou ruído |
| Reconhecimento do turno | `jarvis_agent_user_turn_recognized`, `agent_user_turns_recognized` |
| Áudio remoto e primeiro pacote local | `agent_first_audio_ms`, `agent_first_playback_ms` |
| Processamento após envio | `agent_remote_first_audio_ms`; se o áudio chegar antes de terminar o upload, conta `agent_audio_before_input_finished` sem inventar duração zero |
| Captura até primeiro pacote local | `agent_end_to_end_first_playback_ms`, incluindo captura, wake/STT, fila e conexão quando houver timestamp válido |
| Drenagem e disponibilidade | `agent_playback_drained_ms`, `next_question_ready_ms` |

O primeiro pacote local não mede o instante em que o Discord entregou áudio ao
ouvinte. Os tempos cumulativos não devem ser somados como se fossem etapas
independentes. Média sem amostras não é zero. Para cada pico próximo de 45 s,
correlacione a última etapa conhecida, código sanitizado, conclusão, ferramenta
pendente e drenagem; um agregado isolado não prova a causa.

O upload mantém pacing de 20 ms e preserva toda a fonte. O padding sintético final
agora completa pelo menos 800 ms de zeros digitais levando em conta zeros já
existentes no final do PCM, com arredondamento conservador em frames. Valores
próximos de zero e ruído não reduzem esse padding. Essa redução é comprovável
com PCM controlado; um microfone com ruído pode não apresentar ganho algum.

Preencha os resultados reais separadamente dos testes automatizados. Só declare
aceitação depois de ouvir áudio correto, continuidade, isolamento, ausência de
spam e personalidade, incluindo a comparação de latência. Sem essa execução,
a entrega é uma implementação preparada para validação, com produção pendente.
