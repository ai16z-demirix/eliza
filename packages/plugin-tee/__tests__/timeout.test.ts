import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RemoteAttestationProvider } from '../src/providers/remoteAttestationProvider';
import { DeriveKeyProvider } from '../src/providers/deriveKeyProvider';
import { TEEMode } from '../src/types/tee';
import { TappdClient } from '@phala/dstack-sdk';

// Mock TappdClient
vi.mock('@phala/dstack-sdk', () => ({
    TappdClient: vi.fn().mockImplementation(() => ({
        tdxQuote: vi.fn(),
        deriveKey: vi.fn()
    }))
}));

describe('TEE Provider Timeout Tests', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('RemoteAttestationProvider', () => {
        it('should retry on transient failures with exponential backoff', async () => {
            const mockTdxQuote = vi.fn();
            mockTdxQuote
                .mockRejectedValueOnce(new Error('network error'))
                .mockRejectedValueOnce(new Error('connection timeout'))
                .mockResolvedValueOnce({
                    quote: 'success',
                    replayRtmrs: () => ['rtmr0', 'rtmr1', 'rtmr2', 'rtmr3']
                });

            vi.mocked(TappdClient).mockImplementation(() => ({
                tdxQuote: mockTdxQuote,
                deriveKey: vi.fn()
            }));

            const provider = new RemoteAttestationProvider(TEEMode.LOCAL);
            const startTime = Date.now();

            // Start the operation
            const resultPromise = provider.generateAttestation('test-data');

            // Advance timer by the first retry delay (1000ms)
            await vi.advanceTimersByTimeAsync(1000);
            // Advance timer by the second retry delay (2000ms)
            await vi.advanceTimersByTimeAsync(2000);

            const result = await resultPromise;

            // Verify number of retries
            expect(mockTdxQuote).toHaveBeenCalledTimes(3);
            
            // Verify the delays
            expect(Date.now() - startTime).toBe(3000); // 1000ms + 2000ms

            // Verify successful result after retries
            expect(result).toEqual({
                quote: 'success',
                timestamp: expect.any(Number)
            });
        });

        it('should fail after maximum retry attempts', async () => {
            const mockTdxQuote = vi.fn();
            // Simulate 5 consecutive failures
            for (let i = 0; i < 5; i++) {
                mockTdxQuote.mockRejectedValueOnce(new Error('network error'));
            }

            vi.mocked(TappdClient).mockImplementation(() => ({
                tdxQuote: mockTdxQuote,
                deriveKey: vi.fn()
            }));

            const provider = new RemoteAttestationProvider(TEEMode.LOCAL);
            const operation = provider.generateAttestation('test-data')
                .catch(error => {
                    expect(error.message).toBe('Failed to generate TDX Quote: Operation failed after 5 attempts: network error');
                    return error;
                });

            // Advance time for each retry attempt
            for (let i = 0; i < 5; i++) {
                await vi.advanceTimersByTimeAsync(1000 * Math.pow(2, i));
            }

            await operation;
            expect(mockTdxQuote).toHaveBeenCalledTimes(5);
        }, 10000);

        it('should not retry on permanent failures', async () => {
            const mockTdxQuote = vi.fn()
                .mockRejectedValueOnce(new Error('Invalid input data'));

            vi.mocked(TappdClient).mockImplementation(() => ({
                tdxQuote: mockTdxQuote,
                deriveKey: vi.fn()
            }));

            const provider = new RemoteAttestationProvider(TEEMode.LOCAL);

            await expect(() => provider.generateAttestation('test-data'))
                .rejects
                .toThrow('Failed to generate TDX Quote: Invalid input data');

            // Verify no retries were attempted
            expect(mockTdxQuote).toHaveBeenCalledTimes(1);
        });

        it('should handle successful attestation generation on first try', async () => {
            const mockQuote = {
                quote: 'test-quote',
                replayRtmrs: () => ['rtmr0', 'rtmr1', 'rtmr2', 'rtmr3']
            };

            const mockTdxQuote = vi.fn().mockResolvedValueOnce(mockQuote);

            vi.mocked(TappdClient).mockImplementation(() => ({
                tdxQuote: mockTdxQuote,
                deriveKey: vi.fn()
            }));

            const provider = new RemoteAttestationProvider(TEEMode.LOCAL);
            const result = await provider.generateAttestation('test-data');

            // Verify only one attempt was made
            expect(mockTdxQuote).toHaveBeenCalledTimes(1);
            expect(result).toEqual({
                quote: 'test-quote',
                timestamp: expect.any(Number)
            });
        });
    });

    describe('DeriveKeyProvider', () => {
        it('should handle API timeout during key derivation', async () => {
            const mockDeriveKey = vi.fn()
                .mockRejectedValueOnce(new Error('Request timed out'));

            vi.mocked(TappdClient).mockImplementation(() => ({
                tdxQuote: vi.fn(),
                deriveKey: mockDeriveKey
            }));

            const provider = new DeriveKeyProvider(TEEMode.LOCAL);
            await expect(() => provider.rawDeriveKey('test-path', 'test-subject'))
                .rejects
                .toThrow('Request timed out');

            expect(mockDeriveKey).toHaveBeenCalledTimes(1);
            expect(mockDeriveKey).toHaveBeenCalledWith('test-path', 'test-subject');
        });

        it('should handle API timeout during Ed25519 key derivation', async () => {
            const mockDeriveKey = vi.fn()
                .mockRejectedValueOnce(new Error('Request timed out'));

            vi.mocked(TappdClient).mockImplementation(() => ({
                tdxQuote: vi.fn(),
                deriveKey: mockDeriveKey
            }));

            const provider = new DeriveKeyProvider(TEEMode.LOCAL);
            await expect(() => provider.deriveEd25519Keypair('test-path', 'test-subject'))
                .rejects
                .toThrow('Request timed out');

            expect(mockDeriveKey).toHaveBeenCalledTimes(1);
        });
    });
});
