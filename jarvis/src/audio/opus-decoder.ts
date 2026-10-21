import OpusScript from "opusscript";

/** One decoder per speaker/turn. Opus decoder state must never cross speakers. */
export class OpusDecoder {
  private codec: OpusScript | undefined = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);

  decode(packet: Buffer): Buffer {
    if (!this.codec) throw new Error("Decodificador encerrado.");
    if (packet.length === 0 || packet.length > 3_828) {
      throw new RangeError("Pacote Opus inválido.");
    }
    return this.codec.decode(packet);
  }

  delete(): void {
    this.codec?.delete();
    this.codec = undefined;
  }
}
