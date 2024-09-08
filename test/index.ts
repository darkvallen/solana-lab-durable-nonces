import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  NONCE_ACCOUNT_LENGTH,
  NonceAccount,
  PublicKey,
  sendAndConfirmRawTransaction,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { initializeKeypair, makeKeypairs, getExplorerLink } from '@solana-developers/helpers';
import base58 from 'bs58';
import assert from 'assert';
import dotenv from 'dotenv';
dotenv.config();

async function createNonceAccount(
  connection: Connection,
  payer: Keypair,
  nonceKeypair: Keypair,
  authority: PublicKey,
) {
  const rentExemptBalance = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
  // 2. Assemble and submit a transaction that will:
  const tx = new Transaction().add(
    // 2.1. Allocate the account that will be the nonce account.
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: nonceKeypair.publicKey,
      lamports: rentExemptBalance,
      space: NONCE_ACCOUNT_LENGTH,
      programId: SystemProgram.programId,
    }),
    // 2.2. Initialize the nonce account using the `SystemProgram.nonceInitialize` instruction.
    SystemProgram.nonceInitialize({
      noncePubkey: nonceKeypair.publicKey,
      authorizedPubkey: authority,
    }),
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [
    payer,
    nonceKeypair,
  ]);
  console.log('Creating Nonce TX:', getExplorerLink('tx', sig, 'localnet'));

  // 3. Fetch the nonce account.
  const accountInfo = await connection.getAccountInfo(nonceKeypair.publicKey);
  // 4. Serialize the nonce account data and return it.
  return NonceAccount.fromAccountData(accountInfo!.data);
}

describe('durable nonces', () => {
  const connection = new Connection('http://localhost:8899', 'confirmed');
  const AIRDROP_AMOUNT = 3 * LAMPORTS_PER_SOL;
  const MINIMUM_BALANCE = 1 * LAMPORTS_PER_SOL;
  const TRANSFER_AMOUNT = 0.1 * LAMPORTS_PER_SOL;


  it("Creates a durable transaction and submits it", async () => {
    // Step 1: Initialize the payer
    const payer = await initializeKeypair(connection, {
      airdropAmount: AIRDROP_AMOUNT,
      minimumBalance: MINIMUM_BALANCE,
    });

    // Step 1.1: Create keypairs for nonce account and recipient
    const [nonceKeypair, recipient] = makeKeypairs(2);

    // Step 1.2: Create the nonce account
    const nonceAccount = await createNonceAccount(
      connection,
      payer,
      nonceKeypair,
      payer.publicKey,
    );

    // Step 1.3: Create a new transaction
    const durableTx = new Transaction();
    durableTx.feePayer = payer.publicKey;

    // Step 1.4: Set the recentBlockhash to the nonce value from the nonce account
    durableTx.recentBlockhash = nonceAccount.nonce;

    // Step 1.5: Add the `nonceAdvance` instruction as the first instruction
    durableTx.add(
      SystemProgram.nonceAdvance({
        authorizedPubkey: payer.publicKey,
        noncePubkey: nonceKeypair.publicKey,
      }),
    );

    // Step 1.6: Add the transfer instruction
    durableTx.add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient.publicKey,
        lamports: TRANSFER_AMOUNT,
      }),
    );

    // Step 1.7: Sign the transaction with the payer's keypair
    await durableTx.partialSign(payer);

    // Step 1.8: Serialize the transaction (base64 encoding for easier handling)
    const serializedTx = durableTx
      .serialize({ requireAllSignatures: false })
      .toString("base64");

    // Step 1.9: At this point, you can store the durable transaction for future use.
    // ------------------------------------------------------------------

    // Step 2: Submit the durable transaction

    // Step 2.1: Decode the serialized transaction
    const tx = Buffer.from(serializedTx, "base64");

    // Step 2.2: Submit the transaction using `sendAndConfirmRawTransaction`
    const sig = await sendAndConfirmRawTransaction(connection, tx, {
      skipPreflight: true,
    });

    // Step 2.3: Generate and log the explorer link using `getExplorerLink`
    console.log("Transaction Signature:",getExplorerLink('tx',sig,'localnet'));
  });


  it("Fails if the nonce has advanced", async () => {
    try {
      const payer = await initializeKeypair(connection, {
        airdropAmount: AIRDROP_AMOUNT,
        minimumBalance: MINIMUM_BALANCE,
      });
  
      const [nonceKeypair, nonceAuthority, recipient] = makeKeypairs(3);
  
      // Step 1: Create a Durable Transaction.
      const nonceAccount = await createNonceAccount(
        connection,
        payer,
        nonceKeypair,
        nonceAuthority.publicKey,
      );
  
      const durableTransaction = new Transaction();
      durableTransaction.feePayer = payer.publicKey;
      durableTransaction.recentBlockhash = nonceAccount.nonce;
  
      // Add a nonce advance instruction
      durableTransaction.add(
        SystemProgram.nonceAdvance({
          authorizedPubkey: nonceAuthority.publicKey,
          noncePubkey: nonceKeypair.publicKey,
        }),
      );
  
      // Add a transfer instruction
      durableTransaction.add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: recipient.publicKey,
          lamports: TRANSFER_AMOUNT,
        }),
      );
  
      // Sign the transaction with both the payer and nonce authority's keypairs
      await durableTransaction.partialSign(payer, nonceAuthority);
  
      // Serialize the transaction (in base64 format for simplicity)
      const serializedTransaction = durableTransaction
        .serialize({ requireAllSignatures: false })
        .toString("base64");
  
      // Step 2: Advance the nonce
      const nonceAdvanceSignature = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          SystemProgram.nonceAdvance({
            noncePubkey: nonceKeypair.publicKey,
            authorizedPubkey: nonceAuthority.publicKey,
          }),
        ),
        [payer, nonceAuthority],
      );
  
      // Using getExplorerLink from solana-helpers
      console.log("Nonce Advance Signature:",getExplorerLink('tx',nonceAdvanceSignature,'localnet'));
  
      // Deserialize the transaction
      const deserializedTransaction = Buffer.from(serializedTransaction, "base64");
  
      // Step 3: Try to submit the transaction, expecting it to fail due to nonce advancement.
      await assert.rejects(
        sendAndConfirmRawTransaction(connection, deserializedTransaction),
      );
    } catch (error) {
      console.error("Test failed:", error);
      throw error;
    }
  });
  
  it("Advances the nonce account even if the transaction fails", async () => {
    const TRANSFER_AMOUNT = 50;
    const payer = await initializeKeypair(connection, {
      airdropAmount: 3 * LAMPORTS_PER_SOL,
      minimumBalance: 1 * LAMPORTS_PER_SOL,
    });
  
    // Generate keypairs for nonce account, nonce authority, and recipient
    const [nonceKeypair, nonceAuthority, recipient] = makeKeypairs(3);
  
    // Step 1: Create the nonce account
    const nonceAccount = await createNonceAccount(
      connection,
      payer,
      nonceKeypair,
      nonceAuthority.publicKey,
    );
    const nonceBeforeAdvancing = nonceAccount.nonce;
  
    console.log("Nonce Before Advancing:", nonceBeforeAdvancing);
  
    // Step 2: Check payer's balance to ensure it doesn't have enough to transfer
    const balance = await connection.getBalance(payer.publicKey);
  
    // Ensure the balance is less than the transfer amount (50 SOL)
    assert(
      balance < TRANSFER_AMOUNT * LAMPORTS_PER_SOL,
      `Balance too high! Adjust 'TRANSFER_AMOUNT' to be higher than the current balance of ${balance / LAMPORTS_PER_SOL} SOL.`,
    );
  
    // Step 3: Create a durable transaction that will fail
    const durableTx = new Transaction();
    durableTx.feePayer = payer.publicKey;
  
    // Set the recent blockhash to the nonce value from the nonce account
    durableTx.recentBlockhash = nonceAccount.nonce;
  
    // Step 4: Add the nonce advance instruction as the first instruction
    durableTx.add(
      SystemProgram.nonceAdvance({
        authorizedPubkey: nonceAuthority.publicKey,
        noncePubkey: nonceKeypair.publicKey,
      }),
    );
  
    // Step 5: Add a transfer instruction that will fail (since the payer has insufficient funds)
    durableTx.add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient.publicKey,
        lamports: TRANSFER_AMOUNT * LAMPORTS_PER_SOL,
      }),
    );
  
    // Step 6: Sign the transaction with both the payer and nonce authority
    durableTx.sign(payer, nonceAuthority);
  
    // Serialize the transaction and store or send it (if needed)
    const serializedTx = base58.encode(
      durableTx.serialize({ requireAllSignatures: false }),
    );
  
    const tx = base58.decode(serializedTx);
  
    // Step 7: Send the transaction and expect it to fail (due to insufficient funds)
    await assert.rejects(
      sendAndConfirmRawTransaction(connection, tx as Buffer, {
        skipPreflight: true, // Ensure the transaction reaches the network despite the expected failure
      }),
    );
  
    // Step 8: Fetch the nonce account again after the failed transaction
    const nonceAccountAfterAdvancing = await connection.getAccountInfo(
      nonceKeypair.publicKey,
    );
    const nonceAfterAdvancing = NonceAccount.fromAccountData(
      nonceAccountAfterAdvancing!.data,
    ).nonce;
  
    // Step 9: Verify that the nonce has advanced even though the transaction failed
    assert.notEqual(nonceBeforeAdvancing, nonceAfterAdvancing);
  });
  

  it("The nonce account will not advance if the transaction fails because the nonce authority did not sign the transaction", async () => {
    // Step 1: Initialize payer with SOL airdrop
    const payer = await initializeKeypair(connection, {
      airdropAmount: 3 * LAMPORTS_PER_SOL,
      minimumBalance: 1 * LAMPORTS_PER_SOL,
    });
  
    // Step 2: Generate keypairs for nonce account, nonce authority, and recipient
    const [nonceKeypair, nonceAuthority, recipient] = makeKeypairs(3);
  
    // Step 3: Create the nonce account
    const nonceAccount = await createNonceAccount(
      connection,
      payer,
      nonceKeypair,
      nonceAuthority.publicKey,
    );
    const nonceBeforeAdvancing = nonceAccount.nonce;
  
    console.log("Nonce before submitting:", nonceBeforeAdvancing);
  
    // Step 4: Create a durable transaction that will fail (due to missing nonce authority signature)
    const durableTx = new Transaction();
    durableTx.feePayer = payer.publicKey;
  
    // Use the nonce account's stored nonce as the recent blockhash
    durableTx.recentBlockhash = nonceAccount.nonce;
  
    // Add nonce advance instruction
    durableTx.add(
      SystemProgram.nonceAdvance({
        authorizedPubkey: nonceAuthority.publicKey,
        noncePubkey: nonceKeypair.publicKey,
      }),
    );
  
    // Add transfer instruction
    durableTx.add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 0.1 * LAMPORTS_PER_SOL,
      }),
    );
  
    // Sign the transaction only with the payer, omitting nonce authority signature (this will cause the failure)
    durableTx.sign(payer);
  
    // Step 5: Serialize the transaction
    const serializedTx = base58.encode(
      durableTx.serialize({ requireAllSignatures: false }),
    );
  
    // Decode the serialized transaction
    const tx = base58.decode(serializedTx);
  
    // Step 6: Send the transaction and expect it to fail (due to missing nonce authority signature)
    await assert.rejects(
      sendAndConfirmRawTransaction(connection, tx as Buffer, {
        skipPreflight: true, // Ensure the transaction reaches the network despite the expected failure
      }),
    );
  
    // Step 7: Fetch the nonce account again after the failed transaction
    const nonceAccountAfterAdvancing = await connection.getAccountInfo(
      nonceKeypair.publicKey,
    );
    const nonceAfterAdvancing = NonceAccount.fromAccountData(
      nonceAccountAfterAdvancing!.data,
    ).nonce;
  
    // Step 8: Verify that the nonce has not advanced, as the failure was due to the nonce advance instruction
    assert.equal(nonceBeforeAdvancing, nonceAfterAdvancing);
  });
  

  const TRANSACTION_LAMPORTS = 0.1 * LAMPORTS_PER_SOL;

  it("Submits after changing the nonce authority to an already signed address", async () => {
    try {
      // Step 1: Initialize payer with an airdrop
      const payer = await initializeKeypair(connection, {
        airdropAmount: AIRDROP_AMOUNT,
        minimumBalance: MINIMUM_BALANCE,
      });

      // Step 2: Generate keypairs for nonce account, nonce authority, and recipient
      const [nonceKeypair, nonceAuthority, recipient] = makeKeypairs(3);

      // Step 3: Create the nonce account
      const nonceAccount = await createNonceAccount(
        connection,
        payer,
        nonceKeypair,
        nonceAuthority.publicKey,
      );
      const nonceBeforeAdvancing = nonceAccount.nonce;

      console.log("Nonce before submitting:", nonceBeforeAdvancing);

      // Step 4: Create a durable transaction that will initially fail
      const durableTransaction = new Transaction();
      durableTransaction.feePayer = payer.publicKey;

      // Use the nonceAccount's stored nonce as the recent blockhash
      durableTransaction.recentBlockhash = nonceAccount.nonce;

      // Add nonce advance instruction
      durableTransaction.add(
        SystemProgram.nonceAdvance({
          authorizedPubkey: payer.publicKey, // should be nonce authority, will fail
          noncePubkey: nonceKeypair.publicKey,
        }),
      );

      // Add a transfer instruction
      durableTransaction.add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: recipient.publicKey,
          lamports: TRANSACTION_LAMPORTS,
        }),
      );

      // Sign the transaction with the payer
      durableTransaction.sign(payer);

      // Step 5: Serialize and store the transaction
      const serializedTransaction = base58.encode(
        durableTransaction.serialize({ requireAllSignatures: false }),
      );

      const deserializedTx = base58.decode(serializedTransaction);

      // Step 6: Attempt to send the transaction, expect it to fail (due to incorrect authority)
      await assert.rejects(
        sendAndConfirmRawTransaction(connection, deserializedTx as Buffer, {
          skipPreflight: true, // Ensures the transaction hits the network despite failure
        }),
      );

      // Step 7: Verify that the nonce did not advance after the failed transaction
      const nonceAccountAfterAdvancing = await connection.getAccountInfo(
        nonceKeypair.publicKey,
      );
      const nonceAfterAdvancing = NonceAccount.fromAccountData(
        nonceAccountAfterAdvancing!.data,
      ).nonce;
      assert.equal(nonceBeforeAdvancing, nonceAfterAdvancing);

      // Step 8: Change the nonce authority to the payer
      const nonceAuthSignature = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          SystemProgram.nonceAuthorize({
            noncePubkey: nonceKeypair.publicKey,
            authorizedPubkey: nonceAuthority.publicKey,
            newAuthorizedPubkey: payer.publicKey, // changing authority to payer
          }),
        ),
        [payer, nonceAuthority],
      );

      console.log("Nonce Auth Signature:",getExplorerLink('tx', nonceAuthSignature, 'localnet'));

      // Step 9: Submit the transaction again, which should now succeed
      const transactionSignature = await sendAndConfirmRawTransaction(
        connection,
        deserializedTx as Buffer,
        {
          skipPreflight: true, // Ensures submission without preflight checks
        },
      );

      console.log("Transaction Signature:", getExplorerLink('tx', transactionSignature, 'localnet'));
    } catch (error) {
      console.error("Test failed:", error);
      throw error;
    }
  });
});
