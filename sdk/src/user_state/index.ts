import { AccountId } from '@aztec/barretenberg/account_id';
import { EthAddress } from '@aztec/barretenberg/address';
import { AssetId, AssetIds } from '@aztec/barretenberg/asset';
import { toBigIntBE } from '@aztec/barretenberg/bigint_buffer';
import { Block } from '@aztec/barretenberg/block_source';
import { ProofData, ProofId } from '@aztec/barretenberg/client_proofs';
import { Grumpkin } from '@aztec/barretenberg/ecc';
import { MemoryFifo } from '@aztec/barretenberg/fifo';
import {
  batchDecryptNotes,
  DefiInteractionNote,
  deriveNoteSecret,
  NoteAlgorithms,
  recoverTreeNotes,
  TreeNote,
} from '@aztec/barretenberg/note_algorithms';
import {
  OffchainAccountData,
  OffchainDefiDepositData,
  OffchainJoinSplitData,
} from '@aztec/barretenberg/offchain_tx_data';
import { InnerProofData, RollupProofData } from '@aztec/barretenberg/rollup_proof';
import { RollupProvider } from '@aztec/barretenberg/rollup_provider';
import { TxHash } from '@aztec/barretenberg/tx_hash';
import { ViewingKey } from '@aztec/barretenberg/viewing_key';
import createDebug from 'debug';
import { EventEmitter } from 'events';
import { Database } from '../database';
import { Note } from '../note';
import { NotePicker } from '../note_picker';
import { ProofOutput } from '../proofs/proof_output';
import { UserData } from '../user';
import { UserAccountTx, UserDefiTx, UserJoinSplitTx, UserUtilTx } from '../user_tx';

const debug = createDebug('bb:user_state');

export enum UserStateEvent {
  UPDATED_USER_STATE = 'UPDATED_USER_STATE',
}

enum SyncState {
  OFF,
  SYNCHING,
  MONITORING,
}

export class UserState extends EventEmitter {
  private notePickers: NotePicker[] = [];
  private blockQueue = new MemoryFifo<Block>();
  private syncState = SyncState.OFF;
  private syncingPromise!: Promise<void>;

  constructor(
    private user: UserData,
    private grumpkin: Grumpkin,
    private noteAlgos: NoteAlgorithms,
    private db: Database,
    private rollupProvider: RollupProvider,
  ) {
    super();
  }

  /**
   * Load/refresh user state.
   */
  public async init() {
    this.user = (await this.db.getUser(this.user.id))!;
    await this.resetData();
    await this.refreshNotePicker();
  }

  /**
   * First handles all historical blocks.
   * Then starts processing blocks added to queue via `processBlock()`.
   */
  public async startSync() {
    if (this.syncState !== SyncState.OFF) {
      return;
    }
    const start = new Date().getTime();
    debug(`starting sync for ${this.user.id} from rollup block ${this.user.syncedToRollup + 1}...`);
    this.syncState = SyncState.SYNCHING;
    const blocks = await this.rollupProvider.getBlocks(this.user.syncedToRollup + 1);
    await this.handleBlocks(blocks);
    debug(`sync complete in ${new Date().getTime() - start}ms.`);
    this.syncingPromise = this.blockQueue.process(async block => this.handleBlocks([block]));
    this.syncState = SyncState.MONITORING;
  }

  /**
   * Stops processing queued blocks. Blocks until any processing is complete.
   */
  public stopSync(flush = false) {
    if (this.syncState === SyncState.OFF) {
      return;
    }
    debug(`stopping sync for ${this.user.id}.`);
    flush ? this.blockQueue.end() : this.blockQueue.cancel();
    this.syncState = SyncState.OFF;
    return this.syncingPromise;
  }

  public isSyncing() {
    return this.syncState === SyncState.SYNCHING;
  }

  public getUser() {
    return this.user;
  }

  public processBlock(block: Block) {
    this.blockQueue.put(block);
  }

  public async handleBlocks(blocks: Block[]) {
    blocks = blocks.filter(b => b.rollupId > this.user.syncedToRollup);
    if (blocks.length == 0) {
      return;
    }

    const balancesBefore = AssetIds.map(assetId => this.getBalance(assetId));

    const rollupProofData = blocks.map(b => RollupProofData.fromBuffer(b.rollupProofData));
    const innerProofs = rollupProofData.map(p => p.innerProofData.filter(i => !i.isPadding())).flat();
    const offchainTxDataBuffers = blocks.map(b => b.offchainTxData).flat();
    const viewingKeys: ViewingKey[] = [];
    const noteCommitments: Buffer[] = [];
    const inputNullifiers: Buffer[] = [];
    const offchainAccountData: OffchainAccountData[] = [];
    const offchainDefiDepositData: OffchainDefiDepositData[] = [];
    innerProofs.forEach((proof, i) => {
      switch (proof.proofId) {
        case ProofId.DEPOSIT:
        case ProofId.WITHDRAW:
        case ProofId.SEND: {
          const offchainTxData = OffchainJoinSplitData.fromBuffer(offchainTxDataBuffers[i]);
          viewingKeys.push(...offchainTxData.viewingKeys);
          const {
            noteCommitment1,
            noteCommitment2,
            nullifier1: inputNullifier1,
            nullifier2: inputNullifier2,
          } = innerProofs[i];
          noteCommitments.push(noteCommitment1);
          noteCommitments.push(noteCommitment2);
          inputNullifiers.push(inputNullifier1);
          inputNullifiers.push(inputNullifier2);
          break;
        }
        case ProofId.ACCOUNT: {
          offchainAccountData.push(OffchainAccountData.fromBuffer(offchainTxDataBuffers[i]));
          break;
        }
        case ProofId.DEFI_DEPOSIT: {
          const offchainTxData = OffchainDefiDepositData.fromBuffer(offchainTxDataBuffers[i]);
          viewingKeys.push(offchainTxData.viewingKey);
          const { noteCommitment2, nullifier2: inputNullifier2 } = innerProofs[i];
          noteCommitments.push(noteCommitment2);
          inputNullifiers.push(inputNullifier2);
          offchainDefiDepositData.push(offchainTxData);
          break;
        }
      }
    });

    const viewingKeysBuf = Buffer.concat(viewingKeys.flat().map(vk => vk.toBuffer()));
    const decryptedTreeNotes = await batchDecryptNotes(
      viewingKeysBuf,
      inputNullifiers,
      this.user.privateKey,
      this.noteAlgos,
      this.grumpkin,
    );
    const treeNotes = recoverTreeNotes(
      decryptedTreeNotes,
      noteCommitments,
      this.user.privateKey,
      this.grumpkin,
      this.noteAlgos,
    );

    let treeNoteStartIndex = 0;
    for (let blockIndex = 0; blockIndex < blocks.length; ++blockIndex) {
      const block = blocks[blockIndex];
      const proofData = rollupProofData[blockIndex];

      for (let i = 0; i < proofData.innerProofData.length; ++i) {
        const proof = proofData.innerProofData[i];
        if (proof.isPadding()) {
          continue;
        }

        const noteStartIndex = proofData.dataStartIndex + i * 2;
        switch (proof.proofId) {
          case ProofId.DEPOSIT:
          case ProofId.WITHDRAW:
          case ProofId.SEND: {
            const [note1, note2] = treeNotes.slice(treeNoteStartIndex, treeNoteStartIndex + 2);
            treeNoteStartIndex += 2;
            if (!note1 && !note2) {
              continue;
            }
            await this.handleJoinSplitTx(proof, noteStartIndex, block.created, note1, note2);
            break;
          }
          case ProofId.ACCOUNT: {
            const [offchainTxData] = offchainAccountData.splice(0, 1);
            await this.handleAccountTx(proof, offchainTxData, noteStartIndex, block.created);
            break;
          }
          case ProofId.DEFI_DEPOSIT: {
            const note2 = treeNotes[treeNoteStartIndex];
            treeNoteStartIndex++;
            const [offchainTxData] = offchainDefiDepositData.splice(0, 1);
            if (!note2) {
              // Both notes should be owned by the same user.
              continue;
            }
            await this.handleDefiDepositTx(proof, offchainTxData, noteStartIndex, block.interactionResult, note2);
            break;
          }
          case ProofId.DEFI_CLAIM:
            await this.handleDefiClaimTx(proof, noteStartIndex, block.created);
            break;
        }
      }

      this.user = { ...this.user, syncedToRollup: proofData.rollupId };
    }

    await this.db.updateUser(this.user);

    AssetIds.forEach((assetId, i) => {
      const balanceAfter = this.getBalance(assetId);
      const diff = balanceAfter - balancesBefore[i];
      if (diff) {
        this.emit(UserStateEvent.UPDATED_USER_STATE, this.user.id, balanceAfter, diff, assetId);
      }
    });

    this.emit(UserStateEvent.UPDATED_USER_STATE, this.user.id);
  }

  private async resetData() {
    const pendingTxs = await this.rollupProvider.getPendingTxs();

    const pendingUserTxIds = await this.db.getUnsettledUserTxs(this.user.id);
    for (const userTxId of pendingUserTxIds) {
      if (!pendingTxs.some(tx => tx.txId.equals(userTxId))) {
        await this.db.removeUserTx(userTxId, this.user.id);
      }
    }

    const pendingNotes = await this.db.getUserPendingNotes(this.user.id);
    for (const note of pendingNotes) {
      if (
        !pendingTxs.some(tx => tx.noteCommitment1.equals(note.commitment) || tx.noteCommitment2.equals(note.commitment))
      ) {
        await this.db.removeNote(note.nullifier);
      }
    }
  }

  private async handleAccountTx(
    proof: InnerProofData,
    offchainTxData: OffchainAccountData,
    noteStartIndex: number,
    blockCreated: Date,
  ) {
    const tx = this.recoverAccountTx(proof, offchainTxData, blockCreated);
    if (!tx.userId.equals(this.user.id)) {
      return;
    }

    const { txHash, userId, newSigningPubKey1, newSigningPubKey2, aliasHash } = tx;

    if (newSigningPubKey1) {
      debug(`user ${this.user.id} adds signing key ${newSigningPubKey1.toString('hex')}.`);
      await this.db.addUserSigningKey({
        accountId: userId,
        key: newSigningPubKey1,
        treeIndex: noteStartIndex,
      });
    }

    if (newSigningPubKey2) {
      debug(`user ${this.user.id} adds signing key ${newSigningPubKey2.toString('hex')}.`);
      await this.db.addUserSigningKey({
        accountId: userId,
        key: newSigningPubKey2,
        treeIndex: noteStartIndex + 1,
      });
    }

    if (!this.user.aliasHash || !this.user.aliasHash.equals(aliasHash)) {
      debug(`user ${this.user.id} updates alias hash ${aliasHash.toString()}.`);
      this.user = { ...this.user, aliasHash };
      await this.db.updateUser(this.user);
    }

    const savedTx = await this.db.getAccountTx(txHash);
    if (savedTx) {
      debug(`settling account tx: ${txHash.toString()}`);
      await this.db.settleAccountTx(txHash, blockCreated);
    } else {
      debug(`recovered account tx: ${txHash.toString()}`);
      await this.db.addAccountTx(tx);
    }
  }

  private async handleJoinSplitTx(
    proof: InnerProofData,
    noteStartIndex: number,
    blockCreated: Date,
    note1?: TreeNote,
    note2?: TreeNote,
  ) {
    const { noteCommitment1, noteCommitment2, nullifier1, nullifier2 } = proof;
    const newNote = await this.processNewNote(noteStartIndex, noteCommitment1, note1);
    const changeNote = await this.processNewNote(noteStartIndex + 1, noteCommitment2, note2);
    if (!newNote && !changeNote) {
      // Neither note was decrypted (change note should always belong to us for txs we created).
      return;
    }

    const destroyedNote1 = await this.nullifyNote(nullifier1);
    const destroyedNote2 = await this.nullifyNote(nullifier2);

    await this.refreshNotePicker();

    const txHash = new TxHash(proof.txId);
    if (proof.proofId === ProofId.SEND && newNote && changeNote) {
      // Tranfering both notes to the user -> should've been created for another tx.
      const tx = this.recoverUtilTx(proof, newNote, changeNote, destroyedNote1, destroyedNote2);
      debug(`recovered util tx: ${txHash}`);
      await this.db.addUtilTx(tx);
    } else {
      const savedTx = await this.db.getJoinSplitTx(txHash, this.user.id);
      if (savedTx) {
        debug(`settling tx: ${txHash}`);
        await this.db.settleJoinSplitTx(txHash, this.user.id, blockCreated);
      } else {
        const tx = this.recoverJoinSplitTx(proof, blockCreated, newNote, changeNote, destroyedNote1, destroyedNote2);
        debug(`recovered tx: ${txHash}`);
        await this.db.addJoinSplitTx(tx);
      }
    }
  }

  private async handleDefiDepositTx(
    proof: InnerProofData,
    offchainTxData: OffchainDefiDepositData,
    noteStartIndex: number,
    interactionResult: DefiInteractionNote[],
    treeNote2: TreeNote,
  ) {
    const { txId, noteCommitment1, noteCommitment2 } = proof;
    const note2 = await this.processNewNote(noteStartIndex + 1, noteCommitment2, treeNote2);
    if (!note2) {
      // Owned by the account with a different nonce.
      return;
    }
    const { bridgeId, depositValue, partialStateSecretEphPubKey } = offchainTxData;
    const partialStateSecret = deriveNoteSecret(
      partialStateSecretEphPubKey,
      this.user.privateKey,
      this.grumpkin,
      TreeNote.LATEST_VERSION,
    );
    const txHash = new TxHash(txId);
    const { totalInputValue, totalOutputValueA, totalOutputValueB, result } = interactionResult.find(r =>
      r.bridgeId.equals(bridgeId),
    )!;
    const outputValueA = !result ? BigInt(0) : (totalOutputValueA * depositValue) / totalInputValue;
    const outputValueB = !result ? BigInt(0) : (totalOutputValueB * depositValue) / totalInputValue;
    await this.addClaim(noteStartIndex, txHash, noteCommitment1, partialStateSecret);

    const { nullifier1, nullifier2 } = proof;
    const destroyedNote1 = await this.nullifyNote(nullifier1);
    const destroyedNote2 = await this.nullifyNote(nullifier2);

    await this.refreshNotePicker();

    const savedTx = await this.db.getDefiTx(txHash);
    if (savedTx) {
      debug(`found defi tx, awaiting claim for settlement: ${txHash}`);
      await this.db.updateDefiTx(txHash, outputValueA, outputValueB);
    } else {
      const utilTx = await this.db.getUtilTxByLink(proof.nullifier1);
      const tx = this.recoverDefiTx(
        proof,
        offchainTxData,
        outputValueA,
        outputValueB,
        note2,
        destroyedNote1,
        destroyedNote2,
        utilTx,
      );
      debug(`recovered defi tx: ${txHash}`);
      await this.db.addDefiTx(tx);
    }
  }

  private async handleDefiClaimTx(proof: InnerProofData, noteStartIndex: number, blockCreated: Date) {
    const { nullifier1 } = proof;
    const claim = await this.db.getClaim(nullifier1);
    if (!claim?.owner.equals(this.user.id)) {
      return;
    }

    const { txHash, secret, owner } = claim;
    const { noteCommitment1, noteCommitment2, nullifier1: inputNullifier1, nullifier2: inputNullifier2 } = proof;
    const { bridgeId, depositValue, outputValueA, outputValueB } = (await this.db.getDefiTx(txHash))!;
    // When generating output notes, set creatorPubKey to 0 (it's a DeFi txn, recipient of note is same as creator of claim note)
    if (!outputValueA && !outputValueB) {
      const treeNote = new TreeNote(
        owner.publicKey,
        depositValue,
        bridgeId.inputAssetId,
        owner.nonce,
        secret,
        Buffer.alloc(32),
        inputNullifier1,
      );
      await this.processNewNote(noteStartIndex, noteCommitment1, treeNote);
    }
    if (outputValueA) {
      const treeNote = new TreeNote(
        owner.publicKey,
        outputValueA,
        bridgeId.outputAssetIdA,
        owner.nonce,
        secret,
        Buffer.alloc(32),
        inputNullifier1,
      );
      await this.processNewNote(noteStartIndex, noteCommitment1, treeNote);
    }
    if (outputValueB) {
      const treeNote = new TreeNote(
        owner.publicKey,
        outputValueB,
        bridgeId.outputAssetIdB,
        owner.nonce,
        secret,
        Buffer.alloc(32),
        inputNullifier2,
      );
      await this.processNewNote(noteStartIndex + 1, noteCommitment2, treeNote);
    }

    await this.refreshNotePicker();

    await this.db.settleDefiTx(txHash, blockCreated);
    debug(`settled defi tx: ${txHash}`);
  }

  private async processNewNote(
    index: number,
    commitment: Buffer,
    treeNote?: TreeNote,
    allowChain = false,
    pending = false,
  ) {
    if (!treeNote) {
      return;
    }

    const { ownerPubKey, noteSecret, value, assetId, nonce, creatorPubKey, inputNullifier } = treeNote;
    const noteOwner = new AccountId(ownerPubKey, nonce);
    if (!noteOwner.equals(this.user.id)) {
      return;
    }

    const nullifier = this.noteAlgos.valueNoteNullifier(commitment, this.user.privateKey);
    const note: Note = {
      assetId,
      value,
      commitment,
      secret: noteSecret,
      nullifier,
      nullified: false,
      owner: this.user.id,
      creatorPubKey,
      inputNullifier,
      index,
      allowChain,
      pending,
    };

    if (value) {
      await this.db.addNote(note);
      debug(`user ${this.user.id} successfully decrypted note at index ${index} with value ${value}.`);
    }

    return note;
  }

  private async nullifyNote(nullifier: Buffer) {
    const note = await this.db.getNoteByNullifier(nullifier);
    if (!note || !note.owner.equals(this.user.id)) {
      return;
    }
    await this.db.nullifyNote(nullifier);
    debug(`user ${this.user.id} nullified note at index ${note.index} with value ${note.value}.`);
    return note;
  }

  private async addClaim(index: number, txHash: TxHash, commitment: Buffer, noteSecret: Buffer) {
    const nullifier = this.noteAlgos.claimNoteNullifier(commitment);
    await this.db.addClaim({
      txHash,
      secret: noteSecret,
      nullifier,
      owner: this.user.id,
    });
    debug(`user ${this.user.id} successfully decrypted claim note at index ${index}.`);
  }

  private recoverJoinSplitTx(
    proof: InnerProofData,
    blockCreated: Date,
    noteCommitment?: Note,
    changeNote?: Note,
    destroyedNote1?: Note,
    destroyedNote2?: Note,
  ) {
    const assetId = proof.assetId.readUInt32BE(28);

    const noteValue = (note?: Note) => (note ? note.value : BigInt(0));
    const privateInput = noteValue(destroyedNote1) + noteValue(destroyedNote2);
    const recipientPrivateOutput = noteValue(noteCommitment);
    const senderPrivateOutput = noteValue(changeNote);

    const publicValue = toBigIntBE(proof.publicValue);
    const publicInput = publicValue * BigInt(proof.proofId === ProofId.DEPOSIT);
    const publicOutput = publicValue * BigInt(proof.proofId === ProofId.WITHDRAW);

    const inputOwner = proof.proofId === ProofId.DEPOSIT ? new EthAddress(proof.publicOwner) : undefined;
    const outputOwner = proof.proofId === ProofId.WITHDRAW ? new EthAddress(proof.publicOwner) : undefined;

    return new UserJoinSplitTx(
      new TxHash(proof.txId),
      this.user.id,
      assetId,
      publicInput,
      publicOutput,
      privateInput,
      recipientPrivateOutput,
      senderPrivateOutput,
      inputOwner,
      outputOwner,
      !!changeNote,
      new Date(),
      blockCreated,
    );
  }

  private recoverAccountTx(proof: InnerProofData, offchainTxData: OffchainAccountData, blockCreated: Date) {
    const { txId, nullifier1 } = proof;
    const { accountPublicKey, accountAliasId, spendingPublicKey1, spendingPublicKey2 } = offchainTxData;
    const txHash = new TxHash(txId);
    const userId = new AccountId(accountPublicKey, accountAliasId.nonce);
    const migrated = !!toBigIntBE(nullifier1);

    return new UserAccountTx(
      txHash,
      userId,
      accountAliasId.aliasHash,
      toBigIntBE(spendingPublicKey1) ? spendingPublicKey1 : undefined,
      toBigIntBE(spendingPublicKey2) ? spendingPublicKey2 : undefined,
      migrated,
      new Date(),
      blockCreated,
    );
  }

  private recoverDefiTx(
    proof: InnerProofData,
    offchainTxData: OffchainDefiDepositData,
    outputValueA: bigint,
    outputValueB: bigint,
    changeNote?: Note,
    destroyedNote1?: Note,
    destroyedNote2?: Note,
    utilTx?: UserUtilTx,
  ) {
    const { txId } = proof;
    const { bridgeId, depositValue, partialStateSecretEphPubKey } = offchainTxData;
    const txHash = new TxHash(txId);
    const partialStateSecret = deriveNoteSecret(partialStateSecretEphPubKey, this.user.privateKey, this.grumpkin);

    const noteValue = (note?: Note) => note?.value || BigInt(0);
    const privateInput = noteValue(destroyedNote1) + noteValue(destroyedNote2);
    const privateOutput = noteValue(changeNote);
    const txFee = privateInput - privateOutput - depositValue + (utilTx?.txFee || BigInt(0));

    return new UserDefiTx(
      txHash,
      this.user.id,
      bridgeId,
      depositValue,
      partialStateSecret,
      txFee,
      new Date(),
      outputValueA,
      outputValueB,
    );
  }

  private recoverUtilTx(
    proof: InnerProofData,
    utilNote: Note,
    changeNote: Note,
    destroyedNote1?: Note,
    destroyedNote2?: Note,
  ) {
    const assetId = utilNote.assetId;

    const noteValue = (note?: Note) => note?.value || BigInt(0);
    const privateInput = noteValue(destroyedNote1) + noteValue(destroyedNote2);
    const txFee = privateInput - utilNote.value - changeNote.value;

    // Currently the only util tx is the j/s created for a defi deposit tx,
    // which always uses the j/s tx's first output note as its input note.
    const forwardLink = utilNote.nullifier;

    return new UserUtilTx(new TxHash(proof.txId), this.user.id, assetId, txFee, forwardLink);
  }

  private async refreshNotePicker() {
    const notesMap: Note[][] = Array(AssetIds.length)
      .fill(0)
      .map(() => []);
    const notes = await this.db.getUserNotes(this.user.id);
    notes.forEach(note => notesMap[note.assetId].push(note));
    this.notePickers = AssetIds.map(assetId => new NotePicker(notesMap[assetId]));
  }

  public async pickNote(assetId: AssetId, value: bigint) {
    const pendingNullifiers = await this.rollupProvider.getPendingNoteNullifiers();
    return this.notePickers[assetId].pickOne(value, pendingNullifiers);
  }

  public async pickNotes(assetId: AssetId, value: bigint) {
    const pendingNullifiers = await this.rollupProvider.getPendingNoteNullifiers();
    return this.notePickers[assetId].pick(value, pendingNullifiers);
  }

  public async getSpendableNotes(assetId: AssetId) {
    const pendingNullifiers = await this.rollupProvider.getPendingNoteNullifiers();
    return this.notePickers[assetId].getSpendableNotes(pendingNullifiers).notes;
  }

  public async getSpendableSum(assetId: AssetId) {
    const pendingNullifiers = await this.rollupProvider.getPendingNoteNullifiers();
    return this.notePickers[assetId].getSpendableSum(pendingNullifiers);
  }

  public async getMaxSpendableValue(assetId: AssetId) {
    const pendingNullifiers = await this.rollupProvider.getPendingNoteNullifiers();
    return this.notePickers[assetId].getMaxSpendableValue(pendingNullifiers);
  }

  public getBalance(assetId: AssetId) {
    return this.notePickers[assetId].getSum();
  }

  public async addProof(proofOutput: ProofOutput) {
    const processProof = async (proof: ProofOutput) => {
      let numAddedNotes = 0;
      if (proof.parentProof) {
        numAddedNotes += await processProof(proof.parentProof);
      }
      await this.addPendingTx(proof);
      return numAddedNotes + (await this.addPendingNotes(proof));
    };

    const numAddedNotes = await processProof(proofOutput);
    if (numAddedNotes) {
      await this.refreshNotePicker();
    }

    // No need to do anything with proof.backwardLink (i.e., mark a note as chained).
    // Rollup provider will return the nullifiers of pending notes, which will be excluded when the sdk is picking notes.

    this.emit(UserStateEvent.UPDATED_USER_STATE, this.user.id);
  }

  public async awaitSynchronised() {
    while (this.syncState === SyncState.SYNCHING) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  private async addPendingTx({ tx, proofData, outputNotes }: ProofOutput) {
    // Tranfering both notes to the user -> should've been created for another tx.
    if (
      tx.proofId === ProofId.SEND &&
      outputNotes[0].ownerPubKey.equals(this.user.publicKey) &&
      outputNotes[0].nonce === this.user.nonce
    ) {
      const proof = new ProofData(proofData);
      const txFee = tx.privateInput - tx.recipientPrivateOutput - tx.senderPrivateOutput;
      // Defi deposit always uses the first output note from its linked j/s tx as the input note.
      const forwardLink = this.noteAlgos.valueNoteNullifier(proof.noteCommitment1, this.user.privateKey);
      const utilTx = new UserUtilTx(tx.txHash, this.user.id, tx.assetId, txFee, forwardLink);
      await this.db.addUtilTx(utilTx);
      return;
    }

    switch (tx.proofId) {
      case ProofId.DEPOSIT:
      case ProofId.WITHDRAW:
      case ProofId.SEND:
        debug(`adding join split tx: ${tx.txHash}`);
        await this.db.addJoinSplitTx(tx);
        break;
      case ProofId.ACCOUNT:
        debug(`adding account tx: ${tx.txHash}`);
        await this.db.addAccountTx(tx);
        break;
      case ProofId.DEFI_DEPOSIT:
        debug(`adding defi tx: ${tx.txHash}`);
        await this.db.addDefiTx(tx);
        break;
    }
  }

  private async addPendingNotes({ outputNotes, proofData }: ProofOutput) {
    const proof = new ProofData(proofData);
    const note1 = await this.processNewNote(0, proof.noteCommitment1, outputNotes[0], proof.allowChainFromNote1, true);
    const note2 = await this.processNewNote(0, proof.noteCommitment2, outputNotes[1], proof.allowChainFromNote2, true);
    return +!!note1?.value + +!!note2?.value;
  }
}

export class UserStateFactory {
  constructor(
    private grumpkin: Grumpkin,
    private noteAlgos: NoteAlgorithms,
    private db: Database,
    private rollupProvider: RollupProvider,
  ) {}

  createUserState(user: UserData) {
    return new UserState(user, this.grumpkin, this.noteAlgos, this.db, this.rollupProvider);
  }
}
