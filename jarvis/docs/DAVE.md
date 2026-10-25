# Spike de Discord Voice / DAVE

Estado em 21/10/2026: implementado o caminho de recepção e reprodução; **Gate B real não executado**. Testes sintéticos demonstram lógica de consentimento, atribuição, limites e contenção de erros. Não demonstram recepção DAVE em uma chamada. A aceitação exige bot de teste, credenciais fora do repositório e humanos consentidos.

## Evidências consultadas

- O [Discord informa que DAVE é padrão desde o início de março de 2026](https://discord.com/blog/every-voice-and-video-call-on-discord-is-now-end-to-end-encrypted), com exceção de Stage Channels.
- O [changelog oficial](https://github.com/discordjs/discord.js/blob/main/packages/voice/CHANGELOG.md) lista `@discordjs/voice` 0.19.2 (13/03/2026), com correção de padding; 0.19.1 tornou Davey obrigatório. Não há nesse changelog uma declaração de correção da issue abaixo.
- A [issue #11653](https://github.com/discordjs/discord.js/issues/11653), aberta em 08/10/2026 e ainda **aberta** na consulta de 21/10/2026, relata falhas intermitentes após MLS welcome com transition ID 0 em 0.19.2. A proposta do autor é hipótese a reproduzir; este projeto não aplica patch nem afirma imunidade.
- A [API oficial de VoiceConnection](https://discord.js.org/docs/packages/voice/0.19.2/VoiceConnection:Class) exige `selfDeaf: false` para recepção. A [API VoiceReceiver](https://discord.js.org/docs/packages/voice/0.19.2/VoiceReceiver:Class) retorna Opus associado ao ID Discord via `subscribe(userId)`.

Versões diretas fixadas no manifesto/lockfile: `@discordjs/voice` 0.19.2, `discord.js` 14.27.0, `opusscript` 0.1.1. Davey observado via `npm ls`: **0.1.12**, fixado no lockfile com as demais transitivas. Usar `npm ci`, nunca atualização flutuante durante a comparação. Node mínimo 22.12; ambiente local observado: **v24.19.0, Windows (`win32`), x64**.

A carga do módulo nativo Davey foi executada com sucesso nesse ambiente. A suíte instancia `DAVESession` com IDs fictícios, verifica o protocolo e reseta a sessão sem rede. Isso valida disponibilidade binária local; não valida negociação MLS nem descriptografia Discord. O encoder e decoder Opus também foram exercitados com um tom sintético, sem voz humana ou credenciais.

## Contrato implementado

`VoiceConnectionManager` entra com `selfDeaf: false`, mantém DAVE no padrão da biblioteca, espera Ready por até 20 s e limita recuperação a 25 s. Shutdown cancela esperas, destrói a conexão e libera streams. Não são requisitados intents privilegiados. A aplicação deve usar apenas Guilds e GuildVoiceStates.

`VoiceReceiver` verifica consentimento/identidade antes de subscribe, antes de construir o decoder, a cada pacote e antes de entregar o turno. O chamador exclui outros bots e membros fora do canal; o receiver também exclui seu próprio ID. Revogação deve chamar `stopUser` imediatamente. Durante playback o áudio é descartado para reduzir eco; isso também impede barge-in nesta primeira versão.

Opus é decodificado em PCM16LE 48 kHz estéreo isolado por usuário. RMS normalizado usa limiar inicial 0,008, ajustável no código somente após medição em PT-BR. Fim por silêncio: aproximadamente 600 ms. Há limite por turno e no máximo 16 streams simultâneos. Buffers são efêmeros e descartados/zerados; o áudio entregue ao próximo componente passa a pertencer a ele. Não há gravação de voz nem logs de transcrições, pacotes ou chaves.

`PlaybackQueue` recebe uma resposta PCM16LE mono completa por chamada, converte para 48 kHz estéreo, codifica Opus em frames de 20 ms e resolve a Promise ao alcançar Idle. Prioridade do dono aplica-se aos itens em espera; uma resposta em andamento termina normalmente. Revogação, saída e interrupção cancelam os itens correspondentes. Fila/duração são limitadas; erros rejeitam a Promise com mensagem fixa.

O gate de wake word é **somente de transcrição**; não é um detector acústico local. O fluxo de voz fica desligado até habilitação explícita do detector externo e consentimento que mencione essa transcrição anterior à ativação. Jarvis/Járvis/Djárvis estão cobertos somente como variantes textuais nos testes; taxa de falso positivo, sotaque, ruído e custo aguardam medição real.

## Execução controlada

1. Rode `npm ci`, `npm run build`, `npm run typecheck`, `npm run lint` e `npm test`. A suíte marca o cenário DAVE real como pendente, não como sucesso.
2. Configure token do **novo bot**, guild/canal de teste e proprietário por environment local não versionado. Não use token Elysium. Registre build dos clientes Discord manualmente e `node --version` / `npm ls @discordjs/voice discord.js @snazzah/davey opusscript`.
3. Use o comando de smoke descrito no README, com IDs explicitamente consentidos. Avise os participantes: este spike conta frames/RMS e não grava voz. Permissões mínimas: View Channel, Connect, Speak; sem Administrator ou intents privilegiados.
4. Com uma pessoa já na call, conecte o bot e fale imediatamente. Repita pelo menos 10 entradas/saídas: a falha reportada é intermitente. Verifique pacotes decodificados, RMS maior que zero e atribuição ao ID correto, sem salvar áudio. O status de smoke mostra somente rótulos numerados e os quatro dígitos finais do ID, em resposta privada ao criador; use falas individuais para conferir a correspondência e não registre IDs completos.
5. Refaça entrando com o bot primeiro e humanos depois; depois dois humanos alternando e sobrepondo falas, mantendo consentimento separado. Revogue um usuário no meio da fala: nenhum turno dele pode ser entregue depois da revogação.
6. Force uma mudança de grupo MLS entrando/saindo com outro cliente. Teste reconexão temporária e troca de endpoint. Para reconexão manual reproduzível, rode `/jarvis leave` e `/jarvis join`, renove consentimentos se a sessão tiver sido encerrada e fale imediatamente com humanos já presentes; repita a ordem inversa. Confirme que um erro de stream não derruba o processo e que um novo evento speaking permite inscrição futura. Registre apenas nome do cenário, versões, contadores e classe sanitizada da falha.
7. Em `npm run smoke:dave`, use `/jarvis tone` para confirmar saída audível com tom sintético sem ElevenLabs. Depois rode o worker normal e `/jarvis ask` para confirmar a voz ElevenAgents. Habilite o fluxo de voz de forma explícita e teste a resposta real à palavra de ativação. Não confunda o fallback de texto com aprovação de recepção.
8. Pare o processo e confirme desconexão e descarte de buffers/tasks. Teste novamente após reiniciar e renovar consentimentos da sessão.

Se #11653 for reproduzida, registre sequência/versões e mantenha o gate bloqueado. Compare versão corrigida confiável quando existir. Qualquer patch exige reprodução, testes, revisão de licença e diff documentado. Não desative DAVE nem use versão pré-DAVE.

## Matriz real de aceitação

Preencher com evidência da chamada; as linhas atuais documentam o que ainda falta.

| Cenário | Discord build | Node | voice / Davey | DAVE / MLS | Repetições reais | Recepção por falante / RMS | Playback | Resultado |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Humanos antes do bot | não informado | 24.19.0 local | 0.19.2 / 0.1.12 | padrão, não observado | 0 | não executado | não executado | pendente |
| Bot antes dos humanos | não informado | 24.19.0 local | 0.19.2 / 0.1.12 | padrão, não observado | 0 | não executado | não executado | pendente |
| Entrada/saída de outro humano | não informado | 24.19.0 local | 0.19.2 / 0.1.12 | transição não observada | 0 | não executado | não executado | pendente |
| Reconexão de rede do bot | não informado | 24.19.0 local | 0.19.2 / 0.1.12 | transição não observada | 0 | não executado | não executado | pendente |
| Reconexão `/leave` + `/join` | não informado | 24.19.0 local | 0.19.2 / 0.1.12 | sessão nova não observada | 0 | não executado | não executado | pendente |
| Playback real via `/ask` | não informado | 24.19.0 local | 0.19.2 / 0.1.12 | padrão, não observado | 0 | não se aplica ao fallback | **não executado** | pendente separado |
| Playback real após wake + fala | não informado | 24.19.0 local | 0.19.2 / 0.1.12 | padrão, não observado | 0 | não executado | **não executado** | pendente separado |
| Revogação / isolamento / eco | não informado | 24.19.0 local | 0.19.2 / 0.1.12 | padrão, não observado | 0 | apenas simulação unitária | apenas simulação unitária | pendente real |

Não publicar latência, WER, taxa de wake falso, custo/hora ou p50/p95 sem medição. O Gate B permanece bloqueio de aceitação enquanto esta matriz não tiver resultados reais.
