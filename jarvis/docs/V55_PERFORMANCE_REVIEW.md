# JARVIS V5.5 — engenharia de desempenho

## Baseline congelado antes das alterações de execução

Base de produção: commit `343f2df` (V5.4.1). Registro inicial em 22/10/2026,
antes de modificar os módulos de execução. Apenas os scripts de benchmark e
este relatório foram preparados nesta etapa. Nenhuma chamada paga, deploy,
publicação de agente ou mudança no Elysium Python foi executada.

Ambiente local: Node 24.19.0, Windows x64, Ryzen 7 7800X3D. Tempos abaixo usam
`performance.now()` monotônico. Buffers são sinais sintéticos; não contêm voz,
transcrições, tokens ou URLs assinadas. O baseline de testes passou com 557
testes, 1 pulado, 30 arquivos.

### Histórico fornecido pelo operador

| Medida | Valor informado | Limitação |
| --- | --- | --- |
| Resposta do agente no painel ElevenLabs | aproximadamente 1,02 s | Não equivale a speaking.start → áudio ouvido no Discord. |
| Duração acumulada de conversas | 1,34 h | Não permite calcular taxa de sucesso ou percentis. |
| Captura Discord + VAD | média 1462 ms | Versão e população não controladas. |
| STT wake remoto | média 560 ms | Não é o ASR conversacional do agente. |
| Abertura ElevenAgents | média 486,6 ms | Não separa signed URL, handshake e negociação. |
| Upload PCM + silêncio | média 2849,5 ms | Inclui pacing, não representa só transferência de rede. |
| Pergunta → primeiro áudio | média histórica 13104,7 ms | Afetada por falhas/extremos e versões diferentes. |

Essas médias não foram somadas nem usadas como um comparativo controlado. Não
há amostras individuais para calcular seus p50/p90/p95. A espera histórica de
45 s não é o comportamento atual de falta de ASR: a V5.4 já separou o deadline
de 10 s após upload, mantendo outro watchdog de geração de 45 s.

### CPU local antes: amostra real de execução com áudio sintético

Artefatos congelados: [V55_BASELINE_CPU.json](V55_BASELINE_CPU.json) e
[V55_BASELINE_AGENT_PACKETS.json](V55_BASELINE_AGENT_PACKETS.json). São resultados
sanitizados de laboratório, não logs privados nem chamadas reais.

| Caso | n | p50 ms | p90 ms | p95 ms | máximo ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Captura 48 kHz estéreo → 16 kHz mono, 1 s | 25 | 31,440 | 34,367 | 35,584 | 36,401 |
| Mesma conversão, 3 s | 25 | 90,778 | 93,425 | 94,604 | 96,495 |
| Conversão 16 → 48 kHz estéreo, 20 ms | 25 | 1,172 | 1,176 | 1,181 | 1,182 |
| Conversão 24 → 48 kHz estéreo, 20 ms | 25 | 1,094 | 1,154 | 1,192 | 1,283 |
| Streaming 24 kHz: primeiro frame de 20 ms | 25 | 0,523 | 0,542 | 0,553 | 0,590 |
| Streaming 24 kHz: 1 s completo | 25 | 25,400 | 26,565 | 26,615 | 28,591 |

O benchmark faz cinco warmups por caso. Preparação da fixture fica fora da
medição; conversão e alocação executadas pelo worker ficam dentro. A inspeção
confirma repetição de seno/cosseno para cada tap e frame: 72 taps por amostra em
48→16 kHz e 24 taps por amostra no streaming 24→48 kHz. Isso justifica testar
reuso limitado de coeficientes, preservando a matemática e as amostras finais.

No caminho real do parser do connector, pacotes sintéticos de 4,8/48/192 KiB
consumiram p50 de aproximadamente 0,020/0,189/0,767 ms por pacote. A cópia do
pacote é candidata a medição, mas esses números não demonstram que ela explique
segundos de espera. Não será mantida uma mudança só por parecer mais rápida.

## Investigação e comparação final

Os artefatos locais [V55_AFTER_CPU.json](V55_AFTER_CPU.json) e
[V55_AFTER_AGENT_PACKETS.json](V55_AFTER_AGENT_PACKETS.json) registram a segunda
amostra no mesmo ambiente. Os baselines acima permanecem congelados.

| Caso | n | p50 antes → depois (ms) | p95 antes → depois (ms) |
| --- | ---: | ---: | ---: |
| Captura 48→16 kHz, 1 s | 25 | 31,440 → 12,056 | 35,584 → 15,999 |
| Captura 48→16 kHz, 3 s | 25 | 90,778 → 35,207 | 94,604 → 37,021 |
| Reprodução 16→48 kHz, 20 ms | 25 | 1,172 → 0,431 | 1,181 → 0,513 |
| Reprodução 24→48 kHz, 20 ms | 25 | 1,094 → 0,422 | 1,192 → 0,494 |
| Streaming 24 kHz, primeiro frame | 25 | 0,523 → 0,181 | 0,553 → 0,234 |
| Streaming 24 kHz, 1 s | 25 | 25,400 → 7,743 | 26,615 → 8,213 |

O cache limitado de coeficientes windowed-sinc reaproveita fases binárias
idênticas, sem arredondar a posição de reamostragem. Testes com hashes do PCM
anterior verificam nove combinações de taxas/canais. Esses resultados medem
CPU local com sinais gerados; não comprovam melhora do áudio percebido, ASR ou
latência de rede. O parser ElevenAgents manteve a mesma ordem de grandeza
(p50 0,021/0,200/0,780 ms por 4,8/48/192 KiB); cópias e ownership dos buffers
foram preservados.

Os cenários `pipeline` usam relógio virtual e provedores/player falsos; seus
tempos de rede e pesquisa são parâmetros do modelo, não medições da Brave,
ElevenLabs ou Discord. O ensaio de envelopes VAD identifica fragmentação em
pausas ao reduzir os 600 ms atuais; por isso o limiar de produção é mantido.
Os testes modelados não aprovam qualidade de reconhecimento em PT-BR.

A auditoria dos números de produção, seus denominadores e o procedimento
offline para obter percentis correlacionados estão em
[INCIDENT_METRICS_REVIEW.md](INCIDENT_METRICS_REVIEW.md). Sem o export JSONL
original não é possível calcular p50/p90/p95 dos agregados históricos nem
atribuir a causa exata dos dois incidentes.
