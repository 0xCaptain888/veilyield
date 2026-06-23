declare module "@zama-fhe/relayer-sdk" {
  export const SepoliaConfig: any;
  export const MainnetConfig: any;

  export interface FhevmInstance {
    createEncryptedInput(contractAddress: string, userAddress: string): EncryptedInput;
    generateKeypair(): { publicKey: string; privateKey: string };
    createEIP712(
      publicKey: string,
      contractAddresses: string[],
      startTimestamp: number,
      durationDays: number,
    ): any;
    userDecrypt(
      handles: { handle: string; contractAddress: string }[],
      privateKey: string,
      publicKey: string,
      signature: string,
      contractAddresses: string[],
      userAddress: string,
      startTimestamp: number,
      durationDays: number,
    ): Promise<Record<string, bigint | number>>;
  }

  export interface EncryptedInput {
    add64(value: bigint | number): EncryptedInput;
    encrypt(): Promise<{ handles: Uint8Array[]; inputProof: Uint8Array }>;
  }

  export function createInstance(config: any): Promise<FhevmInstance>;
}
