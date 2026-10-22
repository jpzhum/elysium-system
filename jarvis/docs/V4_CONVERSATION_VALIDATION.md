# Jarvis V4: turnos consecutivos e validação real

## Estado e evidência

O operador confirmou no pedido V4 que a reprodução progressiva funciona na
chamada real e que `/jarvis ask` já responde com voz. O problema informado agora
é a recusa de perguntas seguintes enquanto a aplicação continua aguardando
`agent_response_complete`. Essa confirmação não valida a fila, o barge-in, a
ativação PT-BR nem cinco perguntas consecutivas da revisão V4.

Na reprodução anterior, o teste independente recebeu 30 eventos `audio`, uma
mensagem `agent_response` e nenhum `agent_response_complete` em 55 s. No incidente
`BABA0C1C`, o Jarvis recebeu 79.360 bytes e terminou com
`AGENT_COMPLETION_MISSING`. O evento estava habilitado na versão publicada
informada, `agtvrsn_0201m5ge5vdfe148necsryg6a6wc`. Esses fatos demonstram a ausência
do sinal nas sessões observadas; não identificam a causa no provedor.

## Contrato do provedor e decisão de recuperação

Os [Client Events oficiais](https://elevenlabs.io/docs/eleven-agents/customization/events/client-events)
distinguem `agent_response`, uma mensagem textual finalizada, de
`agent_response_complete`, a conclusão do turno incluindo ferramentas. Áudio
pode começar antes da mensagem textual. Portanto, mensagem recebida e fila local
vazia não provam que não haverá mais áudio, outra mensagem ou ferramenta.
`interruption` invalida a saída em curso. Pings confirmam saúde do transporte.

Em 21/10/2026, `npm view @elevenlabs/client` retornou **1.30.0**, com shasum
`6b043152c49e02e9849db1cb95fd02a08dc031f9`, igual ao pacote inspecionado na
[pesquisa anterior](ELEVENLABS_STREAMING_RESEARCH.md). A saída de áudio do SDK
não depende do evento de conclusão. A fonte oficial está em
[ElevenLabs packages](https://github.com/elevenlabs/packages/tree/main/packages/client).
Nenhuma dependência foi instalada para substituir o adaptador nesta pesquisa.

A aplicação separa três fronteiras: aceitar uma pergunta, consumir áudio no
Discord e confirmar o fim do turno do provedor. A conclusão explícita continua
sendo o único sinal que confirma geração integral. A revisão permite recuperar
a disponibilidade por solicitação seguinte, mantendo o resultado anterior sem
confirmação:

1. A nova pergunta entra na fila limitada; ela não é enviada simultaneamente ao
   provedor do turno anterior.
2. Quando houve `agent_response`, o áudio local já foi consumido e não há
   ferramenta conhecida pendente, a pergunta em espera pode provocar o fechamento
   da sessão anterior, sem aguardar os 45 s de recuperação.
3. O transporte antigo para de aceitar novos eventos. O áudio válido já aceito
   antes desse corte drena; os resíduos do conversor e do último pacote são
   finalizados. Só então o próximo turno inicia.
4. A geração anterior permanece **sem confirmação** e a sessão substituída não
   pode alimentar a próxima resposta. Essa fronteira não fabrica
   `agent_response_complete` nem incrementa uma conclusão confirmada.
5. Sem pergunta seguinte, permanece a recuperação após 45 s sem progresso;
   ferramentas conhecidas pendentes suspendem essa recuperação, mas os limites
   absolutos continuam válidos. Revogação, saída e cancelamento descartam
   imediatamente a saída correspondente.

Há uma limitação inevitável: mensagem textual e drenagem não revelam ferramentas
remotas não sinalizadas nem uma segunda mensagem futura. A recuperação pode
abandonar geração ainda pendente no servidor; ela é uma decisão explícita de
disponibilidade causada pela próxima solicitação. Não deve aparecer como
conclusão integral. Consertar a entrega de `agent_response_complete` no provedor
continua desejável. A alternativa conservadora seria sempre esperar esse sinal
ou um cancelamento manual, mantendo a espera observada.

Abrir uma sessão nova também não preserva automaticamente a memória da sessão
ElevenAgents encerrada. Contexto de uma sessão reutilizável pertence somente ao
mesmo Discord ID e consentimento. A recuperação não cria histórico compartilhado
nem promete retenção de contexto entre sessões.

## Fila, identidade e cancelamento

A fila aceita por padrão oito perguntas aguardando, com até duas por Discord ID.
`JARVIS_MAX_QUEUED_TURNS` e `JARVIS_MAX_QUEUED_PER_USER` ajustam esses limites;
`JARVIS_QUESTION_QUEUE_TTL_SECONDS` limita a espera a 60 s por padrão, até 120 s.
A prioridade do proprietário atua sobre itens em espera; não cancela uma fala de
convidado já em reprodução. Uma única resposta ocupa a saída da chamada. As
respostas de fila, rejeição por limite e cancelamento devem ser explícitas para
o solicitante.

Identidade vem do Discord ID associado ao canal de áudio autenticado. Texto como
“sou o proprietário” e identificação biométrica não concedem privilégios.
Consentimento de texto não autoriza captura de voz. Aceite, versão do
consentimento e presença no mesmo canal são revalidados antes de iniciar trabalho
enfileirado e antes de aceitar áudio para playback. Sair da chamada, revogar ou
desconectar o bot invalida tarefas pendentes e sessões antigas. Nenhum callback
antigo pode reabrir playback após essa invalidação.

## Voz e barge-in experimental

`JARVIS_VOICE_INPUT=elevenlabs-stt` mantém o wake experimental. O detector usa
Scribe com `language_code=por`; isso solicita português, mas não demonstra
acurácia de “Jarvis” nos microfones, sotaques e ruído desta chamada. A
[documentação STT oficial](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)
inclui português e cobra por duração, modelo e plano. O áudio pré-ativação é
enviado ao STT externo e precisa constar no consentimento individual.

O follow-up configurado por `JARVIS_FOLLOWUP_SECONDS` pode abrir na drenagem
local como permissão temporária para reconhecer a próxima fala sem repetir
wake. Isso não confirma geração concluída. Sem conclusão explícita, essa nova
pergunta continua sujeita à recuperação da sessão anterior e pode perder seu
contexto remoto. Outra pessoa não herda a janela desse falante.

O barge-in de voz fica desabilitado por padrão:
`JARVIS_BARGE_IN_ENABLED=false`. Ativá-lo exige `elevenlabs-stt`.
Quando habilitado, só o Discord ID do proprietário com consentimento de áudio
válido pode apresentar um comando curto e explícito, como “Jarvis parar” ou
“Jarvis cancela”. A frase inteira é validada, com limites e cooldown; mencionar
“parar” dentro de uma pergunta não equivale a cancelar. A invalidação do turno
antigo antecede a limpeza de buffers e a próxima interação.
O comando também é vinculado em memória ao stream que estava audível na captura.
Trocar de resposta ou drenar o stream invalida essa autorização; reconhecimento
STT atrasado não pode cancelar uma fala posterior.

O fluxo normal suprime captura durante playback para reduzir realimentação. O
modo experimental abre uma exceção restrita ao proprietário para detectar o
comando de parada, sem encaminhar sua fala como pergunta normal durante a saída.
Discord separa a origem dos pacotes por usuário, mas não remove o som do bot
captado pelo microfone do proprietário. Comando exato e cooldown reduzem falsos
positivos; não constituem cancelamento acústico de eco nem garantem ausência de
ativações indevidas. Validar com fones primeiro e testar eco separadamente. Um
convidado não ganha autorização ao repetir o mesmo comando.

## Medir latência sem conteúdo

Use o mesmo incidente aleatório para correlacionar o turno. Registre apenas
eventos de etapa, intervalos numéricos em milissegundos, enums fixos, contadores e
limites; não inclua Discord IDs, nomes, perguntas ou conteúdo de resposta.
Eventos ausentes devem permanecer ausentes, sem durações inventadas.

| Marco | Medida e interpretação |
| --- | --- |
| Pergunta recebida | Origem para tempo de fila; não significa envio imediato |
| Captura iniciada / encerrada | Inclui duração da fala e espera do VAD; não é latência do LLM |
| Wake iniciado / encerrado | Chamada STT e decisão; conteúdo transitório nunca é logado |
| Sessão aberta / reutilizada | Separa negociação e uso de sessão já válida |
| Primeiro PCM recebido | Tempo do provedor até o primeiro áudio aceito |
| Conversão / primeiro pacote consumido | Custo PCM/Opus e início do player local |
| Último PCM recebido | Último evento observado; não afirma fim da geração |
| Drenagem local | O áudio aceito foi consumido; não comprova audição humana |
| Turno liberado | Conclusão confirmada, recuperação ou cancelamento são resultados distintos |
| Próxima pergunta iniciada | Espera na fila e intervalo após drenagem anterior |

Contadores de primeiro pacote e `playback_completed` não medem a latência
acústica até o fone do participante. Avalie produção com relógio/cronômetro do
operador e sem gravar áudio. Não declare resposta inferior a dois segundos sem
amostra real, origem do intervalo definida e distribuição medida. Fala capturada
por segmentos e seu envio ao agente em tempo real também consomem tempo; uma
otimização de wake isolada não remove esses custos.

Para comparar latência, registre por turno os intervalos das etapas e agregue
os dados reais. Os agregados locais disponíveis são quantidade de amostras,
soma, mínimo, máximo e último valor; mediana e p95 precisam de uma amostra
separada de observações sanitizadas. Cinco perguntas bastam para o gate
funcional, mas não sustentam uma estimativa confiável de p95 de produção.

## Avaliação de wake acústico local

Não foi feita substituição de STT nem benchmark acústico nesta revisão.
Documentação de idioma ou benchmark do fornecedor não substitui medição PT-BR
no codec e ruído do Discord.

| Candidato | Viabilidade e custos a validar |
| --- | --- |
| STT externo atual | Já integrado e limitado; rede, reconhecimento e segundos enviados têm custo e latência. Estime custo de wake como `wake_audio_seconds / 3600 × tarifa efetiva do plano`, incluindo regras de cobrança do contrato. Barge-in aumenta o volume potencial e compartilha os limites do detector. |
| Porcupine | A [documentação oficial](https://picovoice.ai/docs/porcupine/) lista português, Linux x86_64 e modelos de wake específicos por plataforma. O [SDK Node](https://picovoice.ai/docs/quick-start/porcupine-nodejs/) permite inferência no worker, mas exige AccessKey e cotas da conta. O [código publicado](https://github.com/Picovoice/porcupine/blob/master/LICENSE) usa Apache 2.0; conferir separadamente as condições da conta, engine e modelos antes de distribuir. Não assumir custo zero nem qualidade PT-BR comprovada. |
| openWakeWord | O [projeto oficial](https://github.com/dscripka/openWakeWord) declara suporte atual a inglês; português exigiria pesquisa/modelo e avaliação próprios. Código Apache 2.0 e modelos pré-treinados CC BY-NC-SA 4.0 têm permissões distintas. O caminho principal é Python/ONNX ou TFLite; integração no worker Node exige avaliar runtime, memória e isolamento. Não acrescentar esse processamento ao Elysium Python. |

Plano mínimo para uma decisão posterior: usar participantes consentidos e corpus
de teste próprio autorizado com sotaques PT-BR, microfones, ruído, codec Discord,
fones e eco; medir falsos aceites por hora, rejeições em ativações reais, tempo
até detecção, CPU, RSS e custo externo na instância Render equivalente. Incluir
negativos com nomes semelhantes e com a voz sintetizada do próprio Jarvis.
Dados de benchmark exigem consentimento específico se forem gravados; a revisão
atual não grava nem coleta esse corpus. Escolher critérios antes de comparar.

O modelo futuro roda no Background Worker isolado, somente sobre áudio
consentido. Uma detecção local de wake reduziria o envio pré-ativação ao STT,
mas não elimina o envio da pergunta ao ElevenAgents nem autoriza escuta de
terceiros. Sem resultados medidos e licença apropriada, manter o modo atual
experimental e a alternativa de entrada escrita.

## Deploy manual no Render

1. Execute typecheck, lint, build e toda a suíte Node. Confira a suíte Python e
   que nenhum arquivo do Elysium foi alterado. Registre resultados reais em
   [IMPLEMENTATION_STATUS.md](../IMPLEMENTATION_STATUS.md).
2. Envie o commit revisado para a branch conectada ao serviço existente.
3. No Background Worker Jarvis existente, mantenha Root Directory `jarvis`,
   build `npm ci && npm run build`, start `npm run start`, uma instância e a
   versão Node fixada pelo repositório. Preserve dependências opcionais.
4. Faça deploy manual. Confirme o SHA efetivamente implantado e o encerramento
   da instância anterior antes da audição. Não crie outro serviço por Blueprint
   nem altere o serviço Elysium.
5. Primeiro valide entrada escrita com `JARVIS_VOICE_INPUT=disabled`. Depois,
   se houver consentimento para áudio, habilite `elevenlabs-stt` e solicite
   novo aceite. Ative barge-in em uma etapa separada com
   `JARVIS_BARGE_IN_ENABLED=true` conforme [.env.example](../.env.example).
   Não exponha o Environment.
6. Preserve DAVE; não use fallback de criptografia. Confirmar `jarvis_ready`
   demonstra inicialização, e não a qualidade da conversa.

Para retornar a entrada somente escrita, use `JARVIS_VOICE_INPUT=disabled`,
desabilite barge-in e reinicie o worker, renovando consentimentos conforme o
fluxo existente. `/jarvis ask` continua sendo entrada escrita com resposta
audível; não confundir esse modo com sessão `text_only` do provedor.

## Gate de cinco perguntas na chamada real

1. Entre na sala como proprietário, conecte por `/jarvis join`, ouça
   `/jarvis tone`, leia `/jarvis privacy` e conceda o consentimento adequado.
2. Capture `/jarvis status` antes do teste. Faça cinco perguntas curtas
   consecutivas por `/jarvis ask`, enviando a próxima assim que ouvir terminar
   a fala anterior. Não espere deliberadamente 45 s. Anote os horários e se
   todas foram aceitas/enfileiradas, iniciaram e foram audíveis.
3. Caso `agent_response_complete` continue ausente, confirme que a solicitação
   seguinte libera a fila pela política de recuperação. O resultado anterior
   deve continuar sem confirmação; não aparecer como geração concluída.
4. Envie uma pergunta enquanto outra resposta ainda fala: deve haver aviso de
   fila, sem sobreposição nem cancelamento automático do áudio ativo. Compare
   contador de itens aceitos com iniciados, cancelados, falhos e ainda em fila.
5. Com um segundo participante consentido, verifique isolamento e prioridade
   do proprietário apenas entre itens em espera. Teste revogação e saída da
   sala; perguntas pendentes daquele participante não podem ser executadas.
6. Habilite o modo experimental de voz com novo consentimento. Diga “Jarvis” e
   uma pergunta em português; confirme resposta, faça follow-up dentro da janela
   configurada e, após essa janela, confirme que o wake volta a ser exigido.
   Fala sem consentimento e falso wake não podem iniciar sessão.
7. Apenas com barge-in habilitado e fones, o proprietário diz “Jarvis parar”
   durante playback. A fala deve cessar e áudio antigo não pode reaparecer.
   Faça uma pergunta seguinte e confirme resposta isolada. Um convidado repetindo
   a frase não pode cancelar como proprietário. Teste eco separadamente.
8. Saia e reconecte; confira descarte das tarefas antigas e necessidade de
   consentimento válido. Falhas de rede, ferramentas pendentes, limites e DAVE
   devem estar cobertos em testes isolados; não provoque consumo excessivo para
   substituir esses testes no serviço de produção.

Registre o resultado sem conteúdo da conversa:

```text
Data, hora e fuso:
SHA implantado / versão do agente conferida:
Entrada: escrita / voz consentida
Tom ouvido: sim / não
Perguntas aceitas, enfileiradas, iniciadas, ouvidas: __ / __ / __ / __
Cinco consecutivas sem bloqueio indevido: sim / não
Intervalos medidos por pergunta, sem texto ou Discord IDs:
Conclusão explícita presente: sim / não
Recuperações sem conclusão e cancelamentos:
Dois participantes e prioridade: aprovado / pendente / falhou
Wake e follow-up PT-BR: aprovado / pendente / falhou
Barge-in do proprietário / rejeição de convidado / eco:
Revogação, saída e reconexão:
Incidentes, categorias e códigos sanitizados:
Pendências:
```

Não copie perguntas, respostas, transcrições, PCM/base64, gravações, credenciais,
URLs assinadas, nomes ou Discord IDs para logs ou issues. O gate V4 permanece
pendente até a execução humana. Testes automatizados e sucesso de API não
confirmam conversação natural em uma chamada real.
