# JARVIS V5.8 — Confiabilidade de voz multiusuário

## 1. Revisões e limite do diagnóstico

Auditoria local em 25/10/2026: `main`, HEAD inicial `daa1bbd`, implementação V5.7
`798a9ad` presente. A árvore inicial tinha somente `JARVIS_V6_MEMORIA_CODEX.md`
não rastreado, preservado fora da entrega. README, relatório V5.7, diffs e limites
foram inspecionados antes das alterações. Node 24.19.0/npm 11.17.0, dependências
existentes. Baseline: 697 testes aprovados em 36 arquivos, um gate DAVE real
ignorado; typecheck, lint e build aprovados.

**Revisão e variáveis operacionais do Render continuam desconhecidas.** Foram
solicitados SHA, configuração não secreta e horário/incidente da desconexão.
O relato contém sintomas, sem logs correlacionados ou IDs de captura: não permite
provar quais perguntas reais eram distintas/duplicadas, nem atribuir cada falha
à implementação local. HEAD e Blueprint não preenchem essa lacuna.

`npm run audit:agent`, após build, retornou `missing_configuration`, exit 1,
`configuration_checks_passed=false` e `runtime_behavior_verified=false`.
Não houve comparação autenticada do agente publicado, conversa paga ou teste
de áudio real. O diagnóstico de produção permanece incompleto.

## 2. Causas comprovadas e hipóteses

| Caminho reproduzido | Evidência e mudança |
| --- | --- |
| Monopolização de wake | Backoff V5.7 só afeta transcrições negativas. Seis ativações válidas do mesmo ID gastavam o teto; o segundo recebia quota global. Agora dois consentidos têm até três inícios cada. |
| Follow-up reutilizável enquanto ocupado | O mapa e a flag da Entry autorizavam vários fragmentos durante a janela. Cada resposta agora concede uma continuação, consumida somente após aceitação. |
| Autorização após falha/retomada | Drain temporário concedia follow-up; falha ou novo PCM não o retiravam. A autorização agora é invalidada, sem reabertura por evento antigo. |
| Callback de playback antigo | Progresso apontava apenas para Entry, reutilizada depois. Agora valida também o incidente de origem antes de modificar drain/diagnóstico/follow-up. |
| STT comprado com fila cheia | Duas regressões, limite global/individual, fizeram STT antes da recusa. Capacidade agora é conferida antes de STT e novamente no enqueue. |
| Criador ultrapassava convidado novamente | Continuação voltava à posição 1 mesmo com convidado esperando atrás da resposta do criador. A prioridade agora respeita esse convidado, mantendo a resposta ativa e a autoridade administrativa. |
| Spam de rejeição | Dez tentativas automáticas não tinham cooldown de aviso por pessoa/categoria. Agora produzem dois avisos privados, um por falante, no ensaio controlado. |
| Aviso lento prendia captura rejeitada | Uma DM pendente impedia `onTurn` de concluir. O teste falhou antes de separar REST de feedback da liberação do PCM. |

As seis regressões iniciais de follow-up/capacidade falharam antes das mudanças.
Ultrapassagem e espera por aviso Discord também foram reproduzidas antes de
corrigir. Um teste de saturação do novo feedback encontrou reenvio por evicção
de cooldown; foi corrigido antes do commit, sem atribuí-lo à produção anterior.

**Não comprovado no incidente real:** revisão executada, intenção das falas,
IDs compartilhados de captura, transições VoiceConnection/DAVE, causa original
de encoder/player e autoria de eventual comando de saída. Não se conclui causa
única, standby Render ou ausência de consentimento do criador pela presença de Kel.

V5.7 já tinha dedupe por captura/janela, serialização, backoff negativo, terminais
e liberação únicos, classificação de entrega parcial e recuperação limitada.
Esses mecanismos foram preservados e não são reapresentados como novidades.

## 3. Admissão, limites e configurações propostas

| Recurso | Escopo e política |
| --- | --- |
| Wake pago | Worker: seis inícios por janela móvel de 60 s por padrão; não aumentado. |
| Parcela individual nova | IDs com áudio consentido no canal: `max(1, ceil(global/N))`; dois têm três cada, sozinho mantém seis. Toda chamada também precisa de vaga global. |
| Custo já consumido | Histórico por ID sobrevive a revogação, reconsentimento e troca de sala dentro da janela. Reinício não é orçamento durável de conta. |
| Backoff negativo existente | Duas ausências de wake iniciam 10 s; novas negativas: 20/40/60 s. Erros/abortos não contam como negativa; ativação válida reinicia a sequência. |
| Fila wake | Uma chamada ativa, até duas aguardando, expiração em 8 s; revalida consentimento, parcela e teto ao executar. |
| Perguntas | Sala: oito aguardando, duas por ID, TTL 60 s e PCM pendente até 16 MiB, padrões mantidos. |
| Turnos/sessões | 120 tentativas/hora da sala e duas sessões por worker, padrões mantidos. |
| Captura | VAD/RMS e 12 s totais por padrão, incluindo fim da fala; excesso explícito, sem prefixo tratado como pergunta completa. |
| Follow-up | Uma continuação em 18 s após drain, por ID/canal/versão/turno, com relógio monotônico; não compra wake nem aumenta o limite de perguntas. |

O roster vem de membros atuais com aceite individual, sem inferir identidade
por nome ou transcrição. Não há limite novo ao total de consentimentos: os 16
streams simultâneos do receiver não foram confundidos com o tamanho do roster.
Histórico de negativas continua limitado a 16 registros; custo fica limitado
pelos inícios permitidos na janela. Dedupe continua por captura, não conteúdo.

Tradeoffs: a parcela de outra pessoa não é emprestada automaticamente, mesmo se
ela estiver quieta; pode haver capacidade ociosa. Se N exceder as vagas globais,
não se garante uma chamada por pessoa no minuto. Entradas já em andamento não
são cortadas quando alguém consente depois; cobranças antigas continuam contando.
O comando `/jarvis ask` permanece alternativa quando wake não pode ser admitido.

Uma fala ambiente ainda pode ocupar a única continuação válida: não existe
prova acústica de intenção. A correção limita a reutilização, preservando uma
pergunta consecutiva sem wake após cada resposta. Se outro usuário preencher a
fila durante STT, o enqueue ainda pode recusar depois da chamada já consumida;
não se inventa reembolso. Não há sessão paga especulativa.

Proposta operacional: manter global 6/min, follow-up 18 s, fila 8/2 e captura
12 s enquanto mede a revisão real. Nenhuma variável obrigatória nova. Conferir
no serviço `JARVIS_VOICE_INPUT`, `JARVIS_MAX_WAKE_CHECKS_PER_MINUTE`,
`JARVIS_FOLLOWUP_SECONDS`, `JARVIS_MAX_QUEUED_PER_USER` e SHA efetivo; preservar
uma instância, voz, tools, Brave e retenção consentida. Não copiar o ambiente
integral ou segredos para evidência. Nenhum Blueprint foi aplicado.

## 4. Fila, notificações e playback

Uma pergunta aceita mantém seu incidente estável. Há no máximo uma confirmação
inicial de fila por DM; falha/cancelamento atualiza o mesmo aviso quando possível.
Não se publicam repetidamente posições do mesmo turno. Criador ainda tem
prioridade entre falantes, mas continuações não ultrapassam repetidamente um
convidado já esperando atrás da resposta dele. A ordem mantém posições coerentes.

Rejeições automáticas têm cooldown por ID/categoria, usando o prazo de nova
tentativa disponível, limitado a 1–60 s. As categorias distinguem quota global,
parcela individual, backoff, fila e captura. Se DMs estiverem bloqueadas ou o
estado de avisos saturar, há no máximo um resumo anônimo no canal por minuto.
O controle mantém até 16 cooldowns e 64 avisos de turno, sem timers próprios;
saturação não evicta cooldown vivo para reenviar mensagens. Revogar/sair cerca
avisos antigos. REST lenta não impede liberar a captura ou avançar a fila.

O pipeline ElevenAgents → PCM → Opus → AudioPlayer foi mantido. Falha antes do
primeiro pacote, entrega parcial, confirmação remota, drain e transporte são
estados distintos. Ausência de complete não fabrica sucesso nem causa falha
genérica por si só. Não há replay automático de resposta parcialmente falada.
Callbacks antigos não modificam o playback novo; cada request libera uma vez.

Não foi demonstrado defeito novo de codec ou ligação dos avisos reais de playback
a DAVE. A nova cerca corrige um caminho lógico específico. Os testes existentes
de player/encoder/transporte também foram executados.

## 5. Desconexão final

A frase **“Jarvis desconectado; consentimentos e buffers apagados.”** aparece
somente no handler de `/jarvis leave`, após autorização pelo ID do criador e
reset explícito. Esse caminho agora inclui o incidente do comando no evento
de ciclo de vida. A frase identifica o caminho somente se o código implantado
for equivalente; sem SHA não se conclui quem executou algo ou qual erro o precedeu.

| Motivo técnico | Caminho local |
| --- | --- |
| `explicit_leave` | Comando autenticado; cancela recuperação e não reconecta. |
| `channel_empty` | Último humano saiu; limpeza normal. |
| `channel_changed` | Bot mudou/saiu do canal; pode incluir remoção externa ou exclusão da sala, sem presumir autor. |
| `connection_destroyed` | Transporte destruído; exige novo join/aceite. |
| `shutdown` | Encerramento do worker, diferente de idle do agente. |
| `room_replaced` | Troca de sala autorizada durante join. |

Expiração ElevenAgents não desconecta Discord. Recuperação e seu resultado
continuam nos eventos `voice_recovery_*` e no resumo operacional; erro isolado
de receiver não reconstrói a chamada. Salas temporárias do Elysium exigem eventos
Python/Discord correlacionados. Nenhum Python foi alterado para contornar esse ciclo.

## 6. Métricas e comparação de STT

`/jarvis status detalhes:true`, para o criador, acrescenta métricas por
`falante_N`, sem nome ou ID completo. Rótulos são locais ao processo, removidos
na revogação/saída; falar individualmente no teste permite conferir atribuição.

- Janela de 60 s: capturas, wake solicitado/admitido, recusas individuais/globais,
  ativações, follow-ups, perguntas aceitas/duplicadas/recusadas, confirmadas/
  não confirmadas/parciais e falhas de playback.
- Primeiro PCM remoto: N/p50/p90/p95/máximo desde aceitação, incluindo espera;
  não é som ouvido. Tempo ocupado começa no dispatch e termina na liberação,
  separando fila de processamento/playback.
- Acumulado do processo separado da janela; revisão Render validada ou “não
  informada”, nunca deduzida do checkout. Último motivo de desconexão permanece
  depois de apagar correlações pessoais.
- Até 256 eventos e 16 correlações recentes, sem timers. Saturação é sinalizada
  como janela/participantes incompletos. Inícios wake usam série separada para
  que uma rajada local não esconda chamadas; o orçamento do detector é independente.

| Ensaio controlado | Antes | Depois |
| --- | --- | --- |
| Dois consentidos, primeiro tenta gastar seis ativações | V5.7 permitia seis para um e recusava o outro por quota global. | Primeiro limitado a três; outro mantém parcela, total ≤6/min. |
| Dez negativas rápidas + chamada do outro | Backoff V5.7 já evitava oito chamadas. | Mantido: dois STTs ambientes + um dirigido; oito recusas locais, uma pergunta aceita. Papéis invertidos também testados. |
| Fila comprovadamente cheia, global/individual | Um STT antes da recusa em cada regressão. | Zero STT; fila/turno do outro preservados. |
| Dez rejeições alternadas | Avisos públicos repetidos. | Dois avisos privados; zero mensagens no canal com DMs disponíveis. |
| 20 perguntas alternadas, falha na quarta | Sem baseline pareado de produção. | 20 aceitas, 19 confirmadas, uma parcial, quatro chamadas wake; inclui revogar Kel durante pergunta do criador. |

Esses números usam áudio sintético, relógio/protocolo controlados e componentes
locais reais. Não são créditos faturados, custo/hora ou reconhecimento PT-BR
medidos em chamada. Não se aumentou o teto ou plano. O orçamento de wake já era
separado do de perguntas; a V5.8 preserva essa separação e evita compras inúteis
quando a fila já está conhecida como cheia. Não se afirma redução de latência real.

## 7. Alternativas locais investigadas

RMS/VAD, silêncio digital, frames, debounce de speaking.start e dedupe por captura
já filtram candidatos localmente. Não equivalem a reconhecer “Jarvis” ou provar
que uma fala se dirige ao assistente. Não foi criado limiar acústico arbitrário.

[Porcupine](https://github.com/Picovoice/porcupine) documenta português; o
[SDK Node](https://picovoice.ai/docs/quick-start/porcupine-nodejs/) documenta
plataformas desktop/Linux, AccessKey e modelo próprio `.ppn`, com modelo `.pv`
para outros idiomas. Não há modelo Jarvis PT-BR/benchmark aprovado neste ambiente.
Conta, termos e custo precisam de decisão antes de adoção.

[openWakeWord](https://github.com/dscripka/openWakeWord) declara suporte atual a
inglês; código e modelos têm licenças distintas: Apache 2.0 e, para os modelos
incluídos, CC BY-NC-SA 4.0. Não foi adotado como substituto PT-BR. Nenhuma
dependência, conta, serviço pago ou detector foi trocado.

## 8. Testes e matriz A–T

Cada sequência mantém o mesmo serviço, receiver, adapter, fila, playback e RAM.
Rede, transporte e consumidor Discord são controlados; Opus/PCM, VAD, scheduler
e adapter são reais. Player controlado não prova audição; há testes complementares
com AudioPlayer real. Cada checkpoint verifica terminal/liberação únicos, fila,
sessões, streams destruídos, PCM apagado, listeners/timers e contexto isolado.
Teardown exige zero timers/sessões/recursos pendentes. Heap/RSS real não foi medido.

| Caso | Evidência automatizada |
| --- | --- |
| A | Dois consentidos alternam 20 turnos de voz no mesmo runtime. |
| B | Resistência 09 e bot-v5: Kel sem aceite não gera subscription/STT; criador continua. |
| C/D | Dez falas ambientes de um e wake dirigido do outro, ambos os papéis. |
| E | Segunda captura pouco depois da primeira: uma fila e confirmação com seu ID. |
| F | Três sobreposições de sinais 220/880 Hz, IDs separados e origem verificada. |
| G/H | PCM de 20 s para cada um; outro já aguarda e recebe resposta depois do drain. |
| I | Dez falas sem wake não viram perguntas; duas chamadas antes do backoff. |
| J | Dez ou mais perguntas distribuídas, incluídas na sequência de 20. |
| K | Global seis, sétima recusada, recuperação após janela; teto móvel preservado. |
| L | Backoff e parcela por ID; renovar aceite não devolve quota. |
| M | Follow-up do criador não é de Kel; segundo fragmento não reutiliza autorização consumida. |
| N | Quarto playback falha; sequência chega ao 20º, 19 confirmados e uma parcial. |
| O | STT falha; outro participante e depois o primeiro concluem perguntas. |
| P | Revogação/saída de um não cancela o outro; novo aceite no retorno. |
| Q | 20 interações sem recriar o serviço por turno. |
| R | Connecting/Ready durante captura/upload/playback; recuperação e saída explícita nos testes de conexão. |
| S | Dez rejeições, DMs bloqueadas, atualização por turno, aviso lento e saturação sem spam. |
| T | Contagem das chamadas simuladas por janela/ID e comparação acima. |

| Gate local final | Resultado |
| --- | --- |
| Typecheck, lint, build e `git diff --check` | Aprovados. |
| Suíte completa | **740 passaram em 38 arquivos; um gate DAVE real ignorado.** Baseline: 697 em 36 arquivos e o mesmo gate ignorado. |
| Resistência | 23 testes sequenciais: 16 anteriores preservados e sete novos ensaios V5.8, cobrindo A–T junto às regressões específicas. |
| Benchmark existente | Passou; cenário virtual de dois falantes: dez confirmadas, nenhuma não confirmada/perdida. Não comprova audição ou custo real. |
| Auditoria do agente | `missing_configuration`, exit 1 esperado; não aprova configuração remota. |
| Discord/ElevenLabs reais | Pendente, sem teste acústico nem deploy. |

Implementação local: **`4912d6f`**, `fix(jarvis): make multiuser voice admission fair and bound feedback`.
Documentação em commit seguinte; consultar `git log -2 --oneline` para ambos.
Nenhum push, deploy ou alteração do agente foi realizado.

## 9. Validação real com Azrael e Kel

Roteiro posterior à implantação autorizada, com uma instância e limites atuais:

1. Registrar SHA Render, horários, ajustes não secretos e orçamento. Conferir
   `/jarvis status detalhes:true` e auditoria somente leitura do agente.
2. Azrael faz join, teste de tom e aceite de áudio. Kel entra sem consentir:
   não deve ser processada, e a pergunta dele continua operacional.
3. Kel aceita áudio individualmente. Conferir duas pessoas no rateio; falar
   separadamente para reconhecer rótulos sem registrar IDs pessoais.
4. Executar 20 perguntas totais alternadas, aguardando respostas. Fora do
   follow-up, observar três verificações por ID e seis globais, espaçar ativações
   e esperar a janela quando necessário. Recusa explícita não é deadlock.
5. Fazer uma continuação sem wake após cada resposta; fala de Kel não usa a dele.
   Depois de aceitar uma continuação, fragmentos adicionais não geram várias
   perguntas gratuitas. Distinguir recusa esperada de pergunta silenciosamente perdida.
6. Testar C/D com falas ambientes, ambos chamando com pequeno intervalo e uma
   sobreposição; verificar atribuição e ausência de notificações repetidas.
7. Uma resposta longa para cada um, seguida de pergunta do outro. Confirmar
   som completo, ordem e liberação. Captura que exceda o limite tem recusa explícita.
8. Revogar/sair com um durante pergunta do outro; conferir continuidade e novo
   aceite no retorno. Após idle do agente, perguntar sem novo join.
9. Uma busca Brave sem provocar 429. Em manutenção, perda de transporte durante
   tom permite verificar recuperação sem comprar pergunta somente para falhar.
10. Comparar métricas sanitizadas por SHA: wake/minuto/ID, follow-ups, fila,
    confirmadas/parciais, falhas, tempos e último encerramento. Confirmar audição
    e reconhecimento semântico; testes locais não substituem essa avaliação.

Reprovar se houver perguntas genuínas sem motivo observável, monopolização por
erro, spam, mistura de identidade, captura sem aceite ou falha deixando o sistema
ocupado. **Gate real permanece pendente: multiusuário não é declarado resolvido
em produção.** Não guardar gravações pessoais ou transcrições para facilitar testes.

## 10. Arquivos, segurança e rollback

- Produção: `src/agents/{session-manager,wake-detector}.ts`, `src/discord/bot.ts`,
  novo `src/discord/voice-feedback.ts`, novo `src/observability/voice-admission-evidence.ts`,
  `src/observability/{metrics,status}.ts`.
- Regressões: `tests/{multiuser,wake-detector,bot-v5,conversation-endurance}.test.ts`,
  novos `tests/{voice-admission-evidence,voice-feedback}.test.ts`.
- Documentação: este relatório, README e IMPLEMENTATION_STATUS.

Sem alterações em Elysium Python, agente/prompt/voz remotos ou locais, Brave,
client tools, memória curta, dependências/lockfile, `.env` ou Blueprint. ID Discord
continua autoridade, consentimento é individual e versão/canal são revalidados.
Logs usam allowlist técnica e incidentes hexadecimais; nenhum áudio, texto pessoal,
token, ID completo ou URL assinada foi registrado.

Rollback de código: `git revert 4912d6f` numa nova revisão após revisão dos
resultados. Base local anterior `daa1bbd`, sem afirmar que ela é o último SHA
operacional do Render. No serviço, escolher o SHA operacional verificado,
preservar uma instância/ambiente/voz e renovar consentimentos no reinício.
Não houve push, deploy, rollback ou publicação automática do agente.

## 11. Limitações e recomendação

Candidata à validação controlada após testes aprovados, identificação do ambiente
e autorização separada de implantação. Permanecem pendentes revisão real,
ASR/VAD PT-BR, intenção/falsos wakes, eco/DAVE/rede, audição, fluidez e custo
faturado. Não se promete intenção perfeita ou conversa ilimitada sob seis
verificações externas por minuto. O objetivo operacional só será aceito com
evidência de Azrael/Kel em chamada real, inclusive após falha e período ocioso.
