# JARVIS V5.4 — estabilidade e personalidade

Revisão local de 22/10/2026, limitada a `jarvis/`. Nenhum deploy, alteração do
agente publicado, serviço, banco, voz ou modelo foi realizado. O Elysium Python
permanece independente. O arquivo não rastreado `JARVIS_V6_MEMORIA_CODEX.md`, já
presente no workspace, não faz parte desta revisão.

## Investigação e classificação

“Confirmado” abaixo significa observado no código ou em teste local. Não equivale
a reproduzir os incidentes de uma chamada real. “Não reproduzido” significa que
não existe evidência local do incidente em produção.

| Questão | Classificação | Evidência e conclusão |
| --- | --- | --- |
| A. Quem encerra Discord Voice? | CONFIRMADO no código | `VoiceConnectionManager.leave()` destrói a conexão. O bot limpa a sala em `/join` substitutivo, `/leave`, shutdown, saída/mudança efetiva do próprio bot, sala sem humanos, destruição externa ou falha definitiva de recuperação. |
| B. Idle ElevenAgents desconecta Discord? | NÃO REPRODUZIDO | `SessionManager.idle()` remove apenas a entrada/sessão do provedor e seu playback. Não chama `voice.leave()` nem limpa `ConsentStore`. Expirar IA não exige novo consentimento enquanto o vínculo com a sala continuar válido. |
| C. Consentimento global? | NÃO REPRODUZIDO | `ConsentStore` guarda autorização e versão por Discord User ID, apenas em RAM. Entrada de convidado não revoga aceite anterior. Revogação/saída removem só esse usuário; reset da sala ou restart remove todos. |
| D. Rejeição de novas perguntas | CONFIRMADO como política; origem do incidente NÃO REPRODUZIDA | Sem aceite atual, fora da sala/voz indisponível, wake em andamento para o mesmo usuário, limite de capturas, fila cheia/por usuário/memória, orçamento de turnos e quota STT podem rejeitar. A quota wake padrão é compartilhada: 6 verificações/minuto por worker; uma fala consentida sem wake também pode consumi-la. Não foi aumentada silenciosamente. |
| E. PCM sem reconhecimento | CONFIRMADO: validação incompleta; causa remota HIPÓTESE | Antes, PCM digitalmente silencioso, inclusive estéreo em oposição de fase que zera no downmix, podia chegar ao fluxo do agente, especialmente no follow-up. A causa dos 119 chunks do log não foi reproduzida: não há áudio nem configuração remota disponíveis. |
| F. Follow-up de 18 segundos | CONFIRMADO | Vinculado a User ID, canal e versão do consentimento após drenagem local. `wake_detected=false, followup=true` é o caminho intencional sem repetir “Jarvis”. Não prova falha de wake. Janela mantida: não há medição real que justifique alterá-la. |
| G. Fila e playback | CONFIRMADO no código/testes | Um turno ativo por sala; identificador de oito hexadecimais por pergunta, fila limitada, prioridade do criador somente entre itens em espera. Captura normal é suprimida durante playback; barge-in existente continua opcional. Deduplicação de captura e aviso de fila por turno já existiam. |
| H. Reconexão transitória | CONFIRMADO: fragilidade anterior | Havia uma tentativa explícita de rejoin; erro transitório durante recuperação abortava toda a recuperação e podia destruir a sala/aceites. Agora há tentativas limitadas no mesmo objeto e prazo total. Isso não prova que foi a causa da desconexão observada. |
| I. Timeout Brave real | CONFIRMADO | Era fixo em 6000 ms, sem retry; o watchdog de aproximadamente 45 s pertence ao turno ElevenAgents. Agora Brave tem deadline total configurável, padrão 5000 ms. |
| J. Duas pessoas e concorrência | CONFIRMADO: limites compartilhados; mistura NÃO REPRODUZIDA | Streams são separados por ID e respostas serializadas; não se mistura PCM dos participantes. Existem limites globais de STT, sessões e fila. Dois falantes podem atingir esses limites, mas isso não demonstra troca de identidade ou perda de consentimento. |
| Reinício Render, remoção Discord, sala temporária Elysium | HIPÓTESE para o incidente | Exigem logs do worker/gateway e ciclo da sala com horários correlacionados. Inspeção somente de leitura de `expedition_voice_service.py` confirma que humanos impedem limpeza; somente o bot Jarvis configurado pode ser ignorado na ocupação, permitindo exclusão quando está sozinho. Nenhuma alteração no Elysium foi feita. Sala apagada ou saída real não deve conservar consentimento. |
| Regressão de personalidade publicada | NÃO REPRODUZIDO | Prompt local já pedia humor e naturalidade, mas continha exemplos formais. Metadados e memória não substituem system prompt. Auditoria retornou `missing_configuration`; não foi possível comparar prompt, First message e workflows publicados. |

## Correções locais

- Discord: recuperação limitada a três rejoins, com backoff de 1 e 2 segundos
  após a primeira tentativa; prazo total de 25 segundos preservado. Erros
  transitórios encerram a tentativa atual, sem apagar consentimento válido.
  Saída real, revogação e falhas definitivas continuam invalidando autorização.
- Voz: descartar PCM inválido/silencioso antes de wake/agente. Capturas de
  360–600 ms não são automaticamente inválidas: podem conter uma pergunta curta.
  Conversão PCM, sample rate negociado, pacing de 20 ms e cauda de pelo menos
  800 ms de silêncio digital já existiam e foram preservados.
- Reconhecimento: prazo separado de 10 segundos após terminar o upload para
  aguardar `user_transcript`. Sem reconhecimento, falha com
  `AGENT_USER_TURN_MISSING`, cancela a sessão e libera a fila. Não é uma cura do
  ASR remoto nem altera o watchdog de geração de 45 segundos. Não há retry de
  áudio automático ou aumento de custos para ocultar o erro.
- Brave: `JARVIS_SEARCH_TIMEOUT_MS=5000` limita headers e corpo da mesma consulta.
  `AbortController` cancela transporte e leitura; respostas tardias são
  descartadas e o slot local é liberado. Não há retries. Timeout retorna a frase
  curta solicitada, sem resultados inventados.
- Observabilidade: estado de conexão/receiver, tentativas e categorias de
  rejeição com incidentes sanitizados. Pesquisa conserva status, latência e
  quantidade de fontes; nenhum áudio, transcrição, consulta, token ou URL
  assinada entra nos logs.
- Personalidade: prompt consolidado com iniciativa, discordância respeitosa,
  humor seco ocasional, afeto por Kel e respostas sérias quando necessário.
  Mantidos identidade, ferramentas, consentimento, variáveis e memória curta.
  O worker continua sem override de system prompt ou tools.

## Arquivos modificados

Todos os caminhos abaixo são relativos a `jarvis/`:

| Área | Arquivos |
| --- | --- |
| Turnos e configuração | `src/agents/session-manager.ts`, `src/config.ts`, `.env.example` |
| Discord e receiver | `src/discord/bot.ts`, `src/discord/voice-connection.ts`, `src/discord/voice-receiver.ts` |
| Pesquisa e observabilidade | `src/tools/game-search.ts`, `src/observability/metrics.ts`, `src/observability/status.ts` |
| Testes de voz/turnos | `tests/agent-turn.test.ts`, `tests/voice-recognition.test.ts`, `tests/voice-connection.test.ts`, `tests/voice-receiver.test.ts`, `tests/multiuser.test.ts`, `tests/recent-conversation-integration.test.ts` |
| Testes de integração/configuração | `tests/bot-v5.test.ts`, `tests/config.test.ts`, `tests/game-search.test.ts`, `tests/observability.test.ts`, `tests/status.test.ts` |
| Prompt e documentação | `agent-system-prompt.md`, `README.md`, `docs/ELEVENLABS.md`, `docs/V5_AGENT_PROMPT.md`, `docs/V52_PERSONALITY.md`, este novo `docs/V54_STABILITY_REVIEW.md` |

Fixtures de voz que antes enviavam silêncio ou menos de um frame foram ajustadas
para PCM com sinal válido; não representam transcrições ou gravações reais.

## Testes locais e limites da evidência

Verificação integrada final em Node 24.19.0:

| Comando em `jarvis/` | Resultado |
| --- | --- |
| `npm run build` | PASSOU |
| `npm run typecheck` | PASSOU |
| `npm run lint` | PASSOU |
| `npm test` | PASSOU: 540 testes, 30 arquivos; 1 teste pulado |
| `git diff --check` (raiz) | PASSOU |
| `npm run audit:agent` | NÃO VALIDADO: `missing_configuration`, saída 1 |

O teste pulado é o gate explícito de DAVE em chamada real, já existente. As
regressões exercitam isolamento de consentimento e streams, fila sem aviso
duplicado, idle da IA independente de Discord, recuperação e retorno a Ready
durante backoff, PCM inválido/silencioso, reconhecimento ausente/tardio,
revogação/cancelamento, deadline Brave nos headers e corpo e aborto durante a
transição entre ambos. PCM negociado foi exercitado em 8, 16, 22,05, 24, 44,1 e
48 kHz. Os testes existentes de playback e ausência de conclusão também passaram.

`npm run audit:agent` foi executado após build: código de saída 1,
`status=missing_configuration`, `runtime_behavior_verified=false`. A configuração
local necessária para ler o agente publicado não estava disponível; consultas
Brave autenticadas não foram executadas. Portanto, a adequação de 5 segundos continua um objetivo inicial de
teste, não uma latência de produção aprovada.

Mocks não validam qualidade de microfone, ASR remoto, DAVE em chamada real,
retomada do Render, latência de internet ou personalidade do modelo publicado.

## Configuração do worker Render

Após revisão e autorização de deploy, usar o worker existente, uma instância:

1. Build `npm ci && npm run build`; start `npm run start`; Node 24.19.0 já usado
   pelo projeto. Não sincronizar Blueprint para criar outro serviço.
2. Definir opcionalmente `JARVIS_SEARCH_TIMEOUT_MS=5000` (aceita 1000–15000 ms).
   O mesmo default é usado sem a variável. `JARVIS_SEARCH_API_KEY` continua
   opcional e deve ser a chave Brave já autorizada; sem chave não há pesquisa.
3. Preservar token, guild, proprietário, agente e chave existentes. Manter o modo
   de entrada de voz deliberadamente autorizado e novo aceite após restart.
   `JARVIS_FOLLOWUP_SECONDS=18` e `JARVIS_SESSION_IDLE_SECONDS=45` permanecem.
4. Não aumentar a quota de wake sem medir rejeições e revisar o custo. Usar
   `/jarvis status` e logs sanitizados para separar limite de STT, fila e ASR.

## System prompt final e ElevenLabs

O texto final completo está em
[`agent-system-prompt.md`](../agent-system-prompt.md). É um artefato local pronto
para revisão; não foi aplicado na conta. Para integrar manualmente:

1. Abrir o agente de `ELEVENLABS_AGENT_ID` e conferir a versão/branch realmente
   usada pelo worker. Salvar a versão anterior do prompt e da configuração para
   rollback, sem exportar credenciais.
2. Comparar o texto publicado com o arquivo. Integrar as seções **Identity**,
   **Creator and authority**, **Relationship with Kel** e **Personality and
   conversational style** sem acumular instruções contraditórias V3/V5/V5.2.
   Se usar o texto completo como base, preservar instruções técnicas adicionais
   da conta nas seções correspondentes. Conferir também nós de workflow e seus
   overrides; nenhum nó deve restaurar o estilo formal antigo.
3. Manter `{{speaker_name}}`, `{{speaker_is_creator}}`, `{{active_game}}` e
   `{{room_context}}`. Não configurar nomes/declarações de voz como autenticação.
   Preservar **Recent conversation**, **Tools and permissions**, **Priority** e
   as restrições de segurança. Memória curta continua apenas do falante atual.
4. Preservar voz e modelo originais. Preservar PCM negociado, com entrada e saída
   suportadas pelo worker, e `text_only=false`. Não mudar VAD especulativamente.
5. Manter First message vazio ou permitir somente o override First message já
   solicitado por `JARVIS_SUPPRESS_FIRST_MESSAGE=true`. Não habilitar override de
   prompt/tools. Conferir `user_transcript`, áudio, respostas, interrupções e
   `agent_response_complete` nos client events.
6. Manter Client Tools `search_game_info(game, query)` e
   `get_voice_participants()` com **Wait for response** ativo. Ver
   [ELEVENLABS.md](ELEVENLABS.md) para schemas e contrato de eventos.
7. Publicar somente mediante autorização para alterar produção. Executar
   `npm run audit:agent` no ambiente configurado e inspecionar o prompt/workflow
   manualmente. Auditoria estática não mede humor nem comprova comportamento.

A separação entre estilo no prompt e mecânica de turnos segue o
[guia oficial de prompting](https://elevenlabs.io/docs/eleven-agents/best-practices/prompting-guide).
Variáveis personalizam a sessão conforme a
[documentação oficial](https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables);
`contextual_update` fornece informação de fundo, conforme os
[eventos cliente → servidor](https://elevenlabs.io/docs/eleven-agents/customization/events/client-to-server-events).

## Procedimento de validação no Discord

Executar somente depois de aprovada a implantação. Usar duas contas reais, com
IDs diferentes, e fones. Registrar versão, pass/fail, incidentes e durações; nunca
gravar conteúdo privado ou payloads. Cada linha abaixo continua pendente de
validação real nesta entrega.

| Cenário obrigatório | Procedimento e resultado esperado |
| --- | --- |
| 1. Criador sozinho | `/jarvis join`, `/jarvis consent audio:true`; pergunta por wake e `/jarvis ask`. Identidade correta, áudio completo. |
| 2. Criador + Kel sem aceite dela | Kel entra e fala sem consentir; só o criador continua sendo processado. Conferir ausência de assinatura/decodificação para o ID não autorizado. |
| 3. Ambos com aceite | Kel aceita; alternar perguntas em voz/texto e perguntar quem fala. Cada sessão mantém ID e memória próprios. Nome imitado/alegação “sou o criador” não concede administração. |
| 4. Entradas, saídas, revogação | Terceiro entra/sai sem afetar outros. Kel revoga durante captura/resposta; seu trabalho para, o criador continua. Ao sair efetivamente e voltar, Kel deve aceitar novamente. |
| 5. Dois usuários falando | Falar simultaneamente e alternar; áudios não se misturam, fila limita trabalho e explica rejeições. Não aceitar várias notificações iguais para o mesmo turnId. |
| 6. Perguntas consecutivas | Cinco perguntas, incluindo uma enquanto há resposta/ferramenta pendente; ordem consistente, sem interromper playback ou travar fila. |
| 7. Follow-up | Após playback, o mesmo usuário pergunta sem wake dentro de 18 s. Outro usuário precisa de seu próprio wake/follow-up. Após 18 s, exigir wake. Silêncio não gera pergunta. Conversa paralela relevante é um risco inerente à janela; medir antes de ajustá-la. |
| 8. Inatividade prolongada | Esperar além de 45 s e de 300 s sem humanos saírem. Discord/receiver/aceites válidos permanecem; nova pergunta abre IA sob demanda. |
| 9. Reconexão | Em ambiente de teste, interromper rede de forma transitória; recuperar sem segundo objeto/conexão. Falha definitiva exige `/jarvis join` e novo consentimento, informado claramente. Restart sempre exige aceite novo. |
| 10. Reconhecimento | Testar fala curta e longa, ruído, pausa e pergunta completa; correlacionar upload/`user_transcript`. Sem ASR, falhar após prazo separado de 10 s, liberar fila; não atribuir à Brave. |
| 11. Texto | `/jarvis ask` para ambos, inclusive sem áudio autorizado; observar regras existentes de consentimento para texto. |
| 12. Brave real | Consultar informação verificável de um jogo usando a chave existente; medir `jarvis_search_result.duration_ms`, status e fontes. Várias consultas respeitam quota; confirmar se 5 s atendem o provedor. |
| 13. Timeout Brave | Com transporte controlado em teste, exceder 5 s; abortar corpo/rede, resposta curta sem fontes inventadas, próxima pergunta executável. Não quebrar a chave de produção para simular timeout. |
| 14. Reprodução completa | Ouvir respostas de vários tamanhos; playback deve drenar e liberar o turno uma vez. |
| 15. Sem evento complete | Teste controlado omite `agent_response_complete`; áudio aceito continua progressivo e drenado, geração fica não confirmada e nova pergunta usa recuperação isolada. Não remover evento da produção só para testar. |

Avaliação de personalidade, depois de confirmar a versão publicada:

| Pedido | Critério de aceitação |
| --- | --- |
| Criador morreu novamente | Humor leve sobre a situação, sem humilhação e sem inventar histórico. |
| Criador toma decisão arriscada | Julgamento próprio e discordância respeitosa, com ironia quando couber. |
| Informação séria | Resposta correta e direta; nenhuma piada obrigatória. |
| Kel conversa | Calor e naturalidade, sem transferir privilégios do criador. |
| Mensagem romântica | Afeto sincero, sem ironia que prejudique a mensagem. |
| Conversa cotidiana | Ritmo natural; sem saudação ou “Certamente, senhor” a cada resposta. |
| Perguntas consecutivas | Referências sustentadas pela memória disponível; perguntar se ambíguas. |
| Pedido técnico | Explicação útil e precisa; humor somente se combinar com o momento. |

Não aprovar personalidade por contagem de palavras: ouvir as oito situações e
avaliar acerto, concisão, respeito e espontaneidade.

## Rollback

Esta entrega não fez deploy. Para desfazer só o trabalho local, revisar o diff e
restaurar seletivamente os arquivos desta revisão; preservar alterações do
usuário e arquivos não rastreados preexistentes. Não usar reset/clean global.

Se uma implantação for autorizada posteriormente, selecionar o último commit
estável no worker existente, manter uma instância e aguardar o processo anterior
terminar. Retirar `JARVIS_SEARCH_TIMEOUT_MS` ao voltar a uma versão anterior.
Restaurar a versão anterior do prompt/configuração no ElevenLabs caso ela tenha
sido publicada separadamente. Como o processo reinicia, obter novo consentimento
individual. Validar voz, `/jarvis ask` e revogação antes de retomar o uso normal.
