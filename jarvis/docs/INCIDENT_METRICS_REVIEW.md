# Auditoria de métricas e pesquisa — 23/10/2026

## Evidência disponível e limites

Esta revisão usa o código de `343f2df`, o diff local e os números fornecidos pelo
operador. Não há exportação dos logs de produção neste checkout. Não foram
executadas chamadas ElevenLabs/Brave, conexão Discord, push ou deploy. Os
identificadores `D51204EF` e `D67BF82A` não permitem reconstruir exceções ausentes
dos registros. A revisão do playback e dos comandos está no relatório principal.

Os totais acumulados não são uma amostra correlacionada: 73 erros de recepção
podem incluir falhas fora de uma captura; 1 erro de decode não explica sozinho
73 erros de recepção. Os 29 `agent_user_turn_missing` não podem ser divididos
pelas 98 sessões para obter taxa de perguntas de voz perdidas: sessões incluem
texto, abertura e reutilização, enquanto a falta de reconhecimento é medida por
turno. Da mesma forma, 68 inícios, 62 conclusões e 3 falhas de reprodução deixam
6 inícios sem conclusão no agregado, mas não distinguem cancelamento, trabalho
em andamento, shutdown ou falha. Requerem eventos do mesmo incidente.

`agent_session_reused=0` não prova um defeito de reuso. O código exige a mesma
identidade Discord, consentimento, canal e contexto ainda válido, além de sessão
ociosa saudável. Os ensaios locais de turnos consecutivos/follow-up exercitam
reuso; intervalos e encerramentos reais precisam ser verificados nos logs.

## Latência e correlação

| Etapa | Média informada (ms) | p50/p90/p95 de produção |
| --- | ---: | --- |
| Fila de perguntas | 5.173,5 | Indisponíveis sem amostras |
| Upload PCM | 4.491,4 | Indisponíveis sem amostras |
| Captura + VAD | 2.859,6 | Indisponíveis sem amostras |
| STT remoto | 686,1 | Indisponíveis sem amostras |
| Abertura ElevenAgents | 535,0 | Indisponíveis sem amostras |
| Fim do upload → primeiro áudio | 365,8 | Indisponíveis; somente subconjunto informado |

Essas médias não são somadas: têm populações e pontos de partida diferentes.
O envio usa pacing de 20 ms por chunk; `agent_audio_upload_ms` inclui o tempo
do áudio enviado e do silêncio final, não apenas rede. A fila inclui espera
por turnos anteriores. Reduzir timeout ou VAD sem evidência não remove essa
causa e pode truncar falas. O silêncio de VAD permanece em 600 ms.

As alterações locais já acrescentavam p90 à mediana/p95 existente. O status
mostra última/média/mín/máx com N acumulado, e mediana/p90/p95 em janela de até
256 observações recentes por etapa. Os percentis usam nearest rank; a mediana
média os dois valores centrais. São distribuições independentes: p95 de uma
etapa não deve ser somado ao p95 de outra.

`scripts/analyze-latency.mjs` acrescenta análise offline de JSONL:

```powershell
# Executar dentro de jarvis, com um export JSONL local já obtido pelo operador.
Get-Content -LiteralPath 'C:\caminho\render-export.jsonl' | node scripts/analyze-latency.mjs
```

O script não lê configuração, não acessa a rede e não grava entrada. Retém
somente incidentes hexadecimais, estados fixos e durações numéricas revisadas.
Ignora propriedades arbitrárias, conteúdo, códigos/mensagens de exceção e
linhas que não sejam JSON. Exportações com prefixos do Render precisam ser
convertidas para JSONL antes; o total `ignored_lines` evidencia essa limitação.
Há limite de 100 mil incidentes e de 65.536 caracteres por linha.

O relatório apresenta N de cada distribuição, eventos sem início, IDs com
múltiplos inícios (excluídos para evitar misturar reinícios/replays), turnos
terminais, contagem por outcome, uploads finalizados observados e uma população
pareada que possui fila, upload, primeiro áudio e primeiro pacote local no mesmo
incidente. As distribuições incluem medidas observadas de turnos falhos ou
incompletos; a população pareada não equivale a turnos concluídos. Seu próprio
histograma de outcomes distingue `completed`, `failed`, `unknown` etc. Upload
cancelado antes do fim não ganha uma duração completa inventada; aparece como
amostra ausente. Só calcula fim do upload → primeiro
áudio quando os dois tempos existem e o áudio não antecedeu o fim do upload;
áudio anterior é contado separadamente e não é transformado em latência zero.
`capture_ms` usa o tempo real de captura (`capture_wait_ms` no log), pois o
campo histórico `capture_ms` pode expressar somente a duração do PCM.
Ausência de `jarvis_agent_turn_started` no export impede correlação completa;
ausência de terminal é indicada. Não é evidência de áudio ouvido no Discord.

## Duas limitações da Brave

`search_calls=5`, `search_success=3`, `search_rate_limited=2` demonstram dois
resultados limitados entre cinco invocações da ferramenta. Não demonstram dois
HTTP 429: o mesmo status é usado pelo limite de concorrência local, intervalo
local de 1 segundo, cooldown comunicado por headers e pelo HTTP 429 real.

Foi acrescentado `rate_limit_source`, enum fixo sem conteúdo:

- `worker_busy`: consulta anterior ainda ativa; nenhuma requisição extra.
- `worker_interval`: intervalo local ainda ativo; nenhuma requisição extra.
- `provider_quota`: cooldown após header de quota esgotada, inclusive em resposta
  HTTP bem sucedida; nenhuma requisição extra durante o cooldown.
- `provider_429`: resposta HTTP 429 ou seu cooldown; nenhuma tentativa automática.

A origem segue para o diagnóstico estruturado. Os limites, 5 s de deadline,
cancelamento, cooldown de até 120 s e política sem retries permanecem iguais.
Testes com fetch falso verificam concorrência, intervalo, quota, HTTP 429 e
contagem exata de requisições. Não é necessário consumir a Brave para verificar
esses casos. A classificação dos dois resultados históricos continua pendente
dos logs originais; os registros novos resolvem a ambiguidade daqui em diante.

## Alterações locais de desempenho

`WindowedSinc` reutiliza somente coeficientes com fase binária idêntica, até
128 fases, com scratch limitado para taxas irregulares. Não quantiza fases,
não altera o formato PCM/Opus e não acrescenta serviços externos. Os testes
locais com hashes do PCM anterior abrangem nove combinações de taxas/canais,
incluindo fases fracionárias; os testes de streaming verificam continuidade.

Os artefatos V55 são ensaios sintéticos locais explicitamente identificados.
O baseline é preservado. Na amostra já existente, 48 kHz estéreo → 16 kHz mono
por 1 s passou de p50 31,440/p95 35,584 ms a 12,056/15,999 ms; streaming 24 kHz
por 1 s passou de p50 25,400/p95 26,615 ms a 7,743/8,213 ms. Não demonstram
resolução dos incidentes nem redução de segundos de latência em produção.
O parser de pacotes ElevenAgents ficou na mesma ordem de grandeza (p50
0,021/0,200/0,780 ms para 4,8/48/192 KiB); isso não justifica remover cópias ou
o isolamento dos buffers. Nenhuma alteração desse tipo foi introduzida.

O arquivo local `JARVIS_V6_MEMORIA_CODEX.md` descreve outra arquitetura e
permanece fora deste trabalho. Não há banco ou memória persistente nova.
