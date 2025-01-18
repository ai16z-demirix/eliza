import {
    type IAgentRuntime,
    type Memory,
    type Provider,
    type State,
    elizaLogger,
} from "@elizaos/core";
import { type TdxQuoteResponse, TappdClient, type TdxQuoteHashAlgorithms } from "@phala/dstack-sdk";
import { type RemoteAttestationQuote, TEEMode, type RemoteAttestationMessage } from "../types/tee";
import { withRetry, RetryableError } from "../utils/retry";

// List of error messages that indicate transient failures
const RETRYABLE_ERROR_PATTERNS = [
    'timeout',
    'network',
    'connection',
    'econnrefused',
    'socket hang up',
    'socket closed',
    'server error',
    '5xx',
    'rate limit'
].map(pattern => new RegExp(pattern, 'i'));

class RemoteAttestationProvider {
    private client: TappdClient;

    constructor(teeMode?: string) {
        let endpoint: string | undefined;

        // Both LOCAL and DOCKER modes use the simulator, just with different endpoints
        switch (teeMode) {
            case TEEMode.LOCAL:
                endpoint = "http://localhost:8090";
                elizaLogger.log(
                    "TEE: Connecting to local simulator at localhost:8090"
                );
                break;
            case TEEMode.DOCKER:
                endpoint = "http://host.docker.internal:8090";
                elizaLogger.log(
                    "TEE: Connecting to simulator via Docker at host.docker.internal:8090"
                );
                break;
            case TEEMode.PRODUCTION:
                endpoint = undefined;
                elizaLogger.log(
                    "TEE: Running in production mode without simulator"
                );
                break;
            default:
                throw new Error(
                    `Invalid TEE_MODE: ${teeMode}. Must be one of: LOCAL, DOCKER, PRODUCTION`
                );
        }

        this.client = endpoint ? new TappdClient(endpoint) : new TappdClient();
    }

    private isRetryableError(error: Error): boolean {
        const errorMessage = error.message.toLowerCase();
        return RETRYABLE_ERROR_PATTERNS.some(pattern => pattern.test(errorMessage));
    }

    async generateAttestation(
        reportData: string,
        hashAlgorithm?: TdxQuoteHashAlgorithms
    ): Promise<RemoteAttestationQuote> {
        try {
            elizaLogger.log("Generating attestation for: ", reportData);
            
            const quote = await withRetry(async () => {
                try {
                    const tdxQuote: TdxQuoteResponse = await this.client.tdxQuote(
                        reportData,
                        hashAlgorithm
                    );
                    const rtmrs = tdxQuote.replayRtmrs();
                    elizaLogger.log(
                        `rtmr0: ${rtmrs[0]}\nrtmr1: ${rtmrs[1]}\nrtmr2: ${rtmrs[2]}\nrtmr3: ${rtmrs[3]}`
                    );
                    return tdxQuote;
                } catch (error) {
                    // If it's a retryable error, wrap it
                    if (error instanceof Error && this.isRetryableError(error)) {
                        throw new RetryableError(error.message);
                    }
                    // Otherwise, rethrow the original error
                    throw error;
                }
            });

            const attestation: RemoteAttestationQuote = {
                quote: quote.quote,
                timestamp: Date.now(),
            };
            elizaLogger.log("Remote attestation quote: ", attestation);
            return attestation;
        } catch (error) {
            console.error("Error generating remote attestation:", error);
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            throw new Error(`Failed to generate TDX Quote: ${errorMessage}`);
        }
    }
}

// Keep the original provider for backwards compatibility
const remoteAttestationProvider: Provider = {
    get: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
        const teeMode = runtime.getSetting("TEE_MODE");
        const provider = new RemoteAttestationProvider(teeMode);
        const agentId = runtime.agentId;

        try {
            const attestationMessage: RemoteAttestationMessage = {
                agentId: agentId,
                timestamp: Date.now(),
                message: {
                    userId: message.userId,
                    roomId: message.roomId,
                    content: message.content.text,
                }
            };
            elizaLogger.log("Generating attestation for: ", JSON.stringify(attestationMessage));
            const attestation = await provider.generateAttestation(JSON.stringify(attestationMessage));
            return `Your Agent's remote attestation is: ${JSON.stringify(attestation)}`;
        } catch (error) {
            console.error("Error in remote attestation provider:", error);
            throw new Error(
                `Failed to generate TDX Quote: ${
                    error instanceof Error ? error.message : "Unknown error"
                }`
            );
        }
    }
};

export { remoteAttestationProvider, RemoteAttestationProvider };
