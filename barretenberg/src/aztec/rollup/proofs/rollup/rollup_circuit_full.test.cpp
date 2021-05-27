#include "index.hpp"
#include "../notes/native/index.hpp"
#include <common/test.hpp>

namespace rollup {
namespace proofs {
namespace rollup {

using namespace barretenberg;
using namespace notes::native::value;
using namespace notes::native::account;
using namespace notes::native::value;
using namespace plonk::stdlib::merkle_tree;

namespace {
std::shared_ptr<waffle::DynamicFileReferenceStringFactory> srs;
join_split::circuit_data join_split_cd;
account::circuit_data account_cd;
claim::circuit_data claim_cd;
std::vector<uint8_t> padding_proof;
} // namespace

class rollup_tests_full : public ::testing::Test {
  protected:
    rollup_tests_full()
    {
        rand_engine = &numeric::random::get_debug_engine(true);
        user = fixtures::create_user_context(rand_engine);
    }

    static void SetUpTestCase()
    {
        std::string CRS_PATH = "../srs_db/ignition";
        srs = std::make_shared<waffle::DynamicFileReferenceStringFactory>(CRS_PATH);
        account_cd = account::compute_circuit_data(srs);
        join_split_cd = join_split::compute_circuit_data(srs);
        padding_proof = join_split_cd.padding_proof;
    }

    void append_notes(std::vector<uint32_t> const& values, uint32_t asset_id = 1)
    {
        for (auto v : values) {
            notes::native::value::value_note note = { v, asset_id, 0, user.owner.public_key, user.note_secret };
            world_state.append_data_note(note);
        }
    }

    void append_account_notes()
    {
        auto account_alias_id = fixtures::generate_account_alias_id(user.alias_hash, 1);
        notes::native::account::account_note note1 = { account_alias_id,
                                                       user.owner.public_key,
                                                       user.signing_keys[0].public_key };
        notes::native::account::account_note note2 = { account_alias_id,
                                                       user.owner.public_key,
                                                       user.signing_keys[1].public_key };
        world_state.append_data_note(note1);
        world_state.append_data_note(note2);
    }

    std::vector<uint8_t> create_join_split_proof(std::array<uint32_t, 2> in_note_idx,
                                                 std::array<uint32_t, 2> in_note_value,
                                                 std::array<uint32_t, 2> out_note_value,
                                                 uint256_t public_input = 0,
                                                 uint256_t public_output = 0,
                                                 uint32_t account_note_idx = 0,
                                                 uint32_t nonce = 0)
    {
        value_note input_note1 = { in_note_value[0], asset_id, nonce, user.owner.public_key, user.note_secret };
        value_note input_note2 = { in_note_value[1], asset_id, nonce, user.owner.public_key, user.note_secret };
        value_note output_note1 = { out_note_value[0], asset_id, nonce, user.owner.public_key, user.note_secret };
        value_note output_note2 = { out_note_value[1], asset_id, nonce, user.owner.public_key, user.note_secret };

        join_split::join_split_tx tx;
        tx.public_input = public_input + tx_fee;
        tx.public_output = public_output;
        tx.num_input_notes = 2;
        tx.input_index = { in_note_idx[0], in_note_idx[1] };
        tx.old_data_root = world_state.data_tree.root();
        tx.input_path = { world_state.data_tree.get_hash_path(in_note_idx[0]),
                          world_state.data_tree.get_hash_path(in_note_idx[1]) };
        tx.input_note = { input_note1, input_note2 };
        tx.output_note = { output_note1, output_note2 };
        tx.account_index = account_note_idx;
        tx.account_path = world_state.data_tree.get_hash_path(account_note_idx);
        tx.signing_pub_key = user.signing_keys[0].public_key;
        tx.account_private_key = user.owner.private_key;
        tx.asset_id = asset_id;
        tx.alias_hash = user.alias_hash;
        tx.nonce = nonce;
        tx.claim_note.defi_interaction_nonce = 0;

        uint8_t owner_address[] = { 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                                    0x00, 0xb4, 0x42, 0xd3, 0x7d, 0xd2, 0x93, 0xa4, 0x3a, 0xde, 0x80,
                                    0x43, 0xe5, 0xa5, 0xb9, 0x57, 0x0f, 0x75, 0xc5, 0x96, 0x04 };
        tx.input_owner = from_buffer<fr>(owner_address);
        tx.output_owner = fr::random_element(rand_engine);

        auto signer = nonce ? user.signing_keys[0] : user.owner;
        tx.signature = sign_join_split_tx(tx, signer, rand_engine);

        Composer composer =
            Composer(join_split_cd.proving_key, join_split_cd.verification_key, join_split_cd.num_gates);
        composer.rand_engine = rand_engine;
        join_split_circuit(composer, tx);
        auto prover = composer.create_unrolled_prover();
        auto join_split_proof = prover.construct_proof();

        return join_split_proof.proof_data;
    }

    std::vector<uint8_t> create_account_proof(uint32_t nonce = 0, uint32_t account_note_idx = 0)
    {
        account::account_tx tx;
        tx.merkle_root = world_state.data_tree.root();
        tx.account_public_key = user.owner.public_key;
        tx.new_account_public_key = user.owner.public_key;
        tx.num_new_keys = 2;
        tx.new_signing_pub_key_1 = user.signing_keys[0].public_key;
        tx.new_signing_pub_key_2 = user.signing_keys[1].public_key;
        tx.alias_hash = user.alias_hash;
        tx.nonce = nonce;
        tx.migrate = true;
        tx.gibberish = fr::random_element();
        tx.account_index = account_note_idx;
        tx.signing_pub_key = user.signing_keys[0].public_key;
        tx.account_path = world_state.data_tree.get_hash_path(account_note_idx);
        tx.sign(nonce ? user.signing_keys[0] : user.owner);

        Composer composer = Composer(account_cd.proving_key, account_cd.verification_key, account_cd.num_gates);
        composer.rand_engine = rand_engine;
        account_circuit(composer, tx);
        auto prover = composer.create_unrolled_prover();
        auto account_proof = prover.construct_proof();

        return account_proof.proof_data;
    }

    world_state::WorldState<MemoryStore> world_state;
    fixtures::user_context user;
    numeric::random::Engine* rand_engine;
    const uint32_t asset_id = 1;
    const uint256_t tx_fee = 7;
};

// Full proofs.
HEAVY_TEST_F(rollup_tests_full, test_1_proof_in_1_rollup_full_proof)
{
    size_t rollup_size = 1;

    append_account_notes();
    append_notes({ 100, 50 });
    world_state.update_root_tree_with_data_root();

    auto join_split_proof = create_join_split_proof({ 2, 3 }, { 100, 50 }, { 70, 50 }, 30, 60);
    auto rollup = create_rollup(world_state, rollup_size, { join_split_proof });

    auto rollup_circuit_data =
        rollup::get_circuit_data(rollup_size, join_split_cd, account_cd, claim_cd, srs, "", true, false, false);
    auto result = verify(rollup, rollup_circuit_data);

    ASSERT_TRUE(result.verified);

    auto rollup_data = rollup_proof_data(result.proof_data);
    EXPECT_EQ(rollup_data.rollup_id, 0UL);
    EXPECT_EQ(rollup_data.rollup_size, rollup_size);
    EXPECT_EQ(rollup_data.data_start_index, 4UL);
    EXPECT_EQ(rollup_data.old_data_root, rollup.old_data_root);
    EXPECT_EQ(rollup_data.new_data_root, rollup.new_data_root);
    EXPECT_EQ(rollup_data.old_null_root, rollup.old_null_root);
    EXPECT_EQ(rollup_data.new_null_root, rollup.new_null_roots.back());
    EXPECT_EQ(rollup_data.old_data_roots_root, rollup.data_roots_root);
    EXPECT_EQ(rollup_data.new_data_roots_root, rollup.data_roots_root);
    for (size_t i = 0; i < rollup_data.total_tx_fees.size(); ++i) {
        EXPECT_EQ(rollup_data.total_tx_fees[i], i == asset_id ? tx_fee : 0UL);
    }
    EXPECT_EQ(rollup_data.inner_proofs.size(), 1UL);

    auto tx_data = inner_proof_data(join_split_proof);
    auto inner_data = rollup_data.inner_proofs[0];
    EXPECT_EQ(inner_data.proof_id, tx_data.proof_id);
    EXPECT_EQ(inner_data.public_input, tx_data.public_input);
    EXPECT_EQ(inner_data.public_output, tx_data.public_output);
    EXPECT_EQ(inner_data.asset_id, tx_data.asset_id);
    EXPECT_EQ(inner_data.new_note1, tx_data.new_note1);
    EXPECT_EQ(inner_data.new_note2, tx_data.new_note2);
    EXPECT_EQ(inner_data.nullifier1, tx_data.nullifier1);
    EXPECT_EQ(inner_data.nullifier2, tx_data.nullifier2);
    EXPECT_EQ(inner_data.input_owner, tx_data.input_owner);
    EXPECT_EQ(inner_data.output_owner, tx_data.output_owner);
}

HEAVY_TEST_F(rollup_tests_full, test_1_proof_in_2_rollup_full_proof)
{
    size_t rollup_size = 2;

    append_account_notes();
    append_notes({ 100, 50 });
    world_state.update_root_tree_with_data_root();
    auto join_split_proof = create_join_split_proof({ 2, 3 }, { 100, 50 }, { 70, 80 });
    auto rollup = create_rollup(world_state, rollup_size, { join_split_proof });

    auto rollup_circuit_data =
        rollup::get_circuit_data(rollup_size, join_split_cd, account_cd, claim_cd, srs, "", true, false, false);
    auto result = verify(rollup, rollup_circuit_data);

    ASSERT_TRUE(result.verified);

    auto rollup_data = rollup_proof_data(result.proof_data);
    EXPECT_EQ(rollup_data.rollup_id, 0UL);
    EXPECT_EQ(rollup_data.rollup_size, rollup_size);
    EXPECT_EQ(rollup_data.data_start_index, 4UL);
    EXPECT_EQ(rollup_data.old_data_root, rollup.old_data_root);
    EXPECT_EQ(rollup_data.new_data_root, rollup.new_data_root);
    EXPECT_EQ(rollup_data.old_null_root, rollup.old_null_root);
    EXPECT_EQ(rollup_data.new_null_root, rollup.new_null_roots.back());
    EXPECT_EQ(rollup_data.old_data_roots_root, rollup.data_roots_root);
    EXPECT_EQ(rollup_data.new_data_roots_root, rollup.data_roots_root);
    for (size_t i = 0; i < rollup_data.total_tx_fees.size(); ++i) {
        EXPECT_EQ(rollup_data.total_tx_fees[i], i == asset_id ? tx_fee : 0UL);
    }
    EXPECT_EQ(rollup_data.inner_proofs.size(), 2UL);

    auto tx_data = inner_proof_data(join_split_proof);
    auto inner_data = rollup_data.inner_proofs[0];
    EXPECT_EQ(inner_data.proof_id, tx_data.proof_id);
    EXPECT_EQ(inner_data.public_input, tx_data.public_input);
    EXPECT_EQ(inner_data.public_output, tx_data.public_output);
    EXPECT_EQ(inner_data.asset_id, tx_data.asset_id);
    EXPECT_EQ(inner_data.new_note1, tx_data.new_note1);
    EXPECT_EQ(inner_data.new_note2, tx_data.new_note2);
    EXPECT_EQ(inner_data.nullifier1, tx_data.nullifier1);
    EXPECT_EQ(inner_data.nullifier2, tx_data.nullifier2);
    EXPECT_EQ(inner_data.input_owner, tx_data.input_owner);
    EXPECT_EQ(inner_data.output_owner, tx_data.output_owner);
}

HEAVY_TEST_F(rollup_tests_full, test_2_proofs_in_2_rollup_full_proof)
{
    size_t rollup_size = 2;

    append_account_notes();
    append_notes({ 0, 0, 100, 50, 80, 60 });
    world_state.update_root_tree_with_data_root();
    auto join_split_proof1 = create_join_split_proof({ 4, 5 }, { 100, 50 }, { 70, 50 }, 30, 60);
    auto join_split_proof2 = create_join_split_proof({ 6, 7 }, { 80, 60 }, { 70, 70 });
    auto txs = std::vector<std::vector<uint8_t>>{ join_split_proof1, join_split_proof2 };

    auto rollup = create_rollup(world_state, rollup_size, txs);

    auto rollup_circuit_data =
        rollup::get_circuit_data(rollup_size, join_split_cd, account_cd, claim_cd, srs, "", true, false, false);
    auto result = verify(rollup, rollup_circuit_data);

    ASSERT_TRUE(result.verified);

    auto rollup_data = rollup_proof_data(result.proof_data);
    EXPECT_EQ(rollup_data.rollup_id, 0UL);
    EXPECT_EQ(rollup_data.rollup_size, rollup_size);
    EXPECT_EQ(rollup_data.data_start_index, 8UL);
    EXPECT_EQ(rollup_data.old_data_root, rollup.old_data_root);
    EXPECT_EQ(rollup_data.new_data_root, rollup.new_data_root);
    EXPECT_EQ(rollup_data.old_null_root, rollup.old_null_root);
    EXPECT_EQ(rollup_data.new_null_root, rollup.new_null_roots.back());
    EXPECT_EQ(rollup_data.old_data_roots_root, rollup.data_roots_root);
    EXPECT_EQ(rollup_data.new_data_roots_root, rollup.data_roots_root);
    for (size_t i = 0; i < rollup_data.total_tx_fees.size(); ++i) {
        EXPECT_EQ(rollup_data.total_tx_fees[i], i == asset_id ? tx_fee * 2 : 0UL);
    }
    EXPECT_EQ(rollup_data.inner_proofs.size(), txs.size());

    for (size_t i = 0; i < txs.size(); ++i) {
        auto tx_data = inner_proof_data(txs[i]);
        auto inner_data = rollup_data.inner_proofs[i];
        EXPECT_EQ(inner_data.proof_id, tx_data.proof_id);
        EXPECT_EQ(inner_data.public_input, tx_data.public_input);
        EXPECT_EQ(inner_data.public_output, tx_data.public_output);
        EXPECT_EQ(inner_data.asset_id, tx_data.asset_id);
        EXPECT_EQ(inner_data.new_note1, tx_data.new_note1);
        EXPECT_EQ(inner_data.new_note2, tx_data.new_note2);
        EXPECT_EQ(inner_data.nullifier1, tx_data.nullifier1);
        EXPECT_EQ(inner_data.nullifier2, tx_data.nullifier2);
        EXPECT_EQ(inner_data.input_owner, tx_data.input_owner);
        EXPECT_EQ(inner_data.output_owner, tx_data.output_owner);
    }
}

HEAVY_TEST_F(rollup_tests_full, test_1_js_proof_1_account_proof_in_2_rollup_full_proof)
{
    size_t rollup_size = 2;

    append_account_notes();
    append_notes({ 0, 0, 100, 50, 80, 60 });
    world_state.update_root_tree_with_data_root();
    auto join_split_proof = create_join_split_proof({ 4, 5 }, { 100, 50 }, { 70, 50 }, 30, 60);
    auto account_proof = create_account_proof();
    auto txs = std::vector<std::vector<uint8_t>>{ join_split_proof, account_proof };
    auto rollup = create_rollup(world_state, rollup_size, txs);

    auto rollup_circuit_data =
        rollup::get_circuit_data(rollup_size, join_split_cd, account_cd, claim_cd, srs, "", true, false, false);
    auto result = verify(rollup, rollup_circuit_data);

    ASSERT_TRUE(result.verified);

    auto rollup_data = rollup_proof_data(result.proof_data);
    EXPECT_EQ(rollup_data.rollup_id, 0UL);
    EXPECT_EQ(rollup_data.rollup_size, rollup_size);
    EXPECT_EQ(rollup_data.data_start_index, 8UL);
    EXPECT_EQ(rollup_data.old_data_root, rollup.old_data_root);
    EXPECT_EQ(rollup_data.new_data_root, rollup.new_data_root);
    EXPECT_EQ(rollup_data.old_null_root, rollup.old_null_root);
    EXPECT_EQ(rollup_data.new_null_root, rollup.new_null_roots.back());
    EXPECT_EQ(rollup_data.old_data_roots_root, rollup.data_roots_root);
    EXPECT_EQ(rollup_data.new_data_roots_root, rollup.data_roots_root);
    for (size_t i = 0; i < rollup_data.total_tx_fees.size(); ++i) {
        EXPECT_EQ(rollup_data.total_tx_fees[i], i == asset_id ? tx_fee : 0UL);
    }
    EXPECT_EQ(rollup_data.inner_proofs.size(), txs.size());

    for (size_t i = 0; i < txs.size(); ++i) {
        auto tx_data = inner_proof_data(txs[i]);
        auto inner_data = rollup_data.inner_proofs[i];
        EXPECT_EQ(inner_data.proof_id, tx_data.proof_id);
        EXPECT_EQ(inner_data.public_input, tx_data.public_input);
        EXPECT_EQ(inner_data.public_output, tx_data.public_output);
        EXPECT_EQ(inner_data.asset_id, tx_data.asset_id);
        EXPECT_EQ(inner_data.new_note1, tx_data.new_note1);
        EXPECT_EQ(inner_data.new_note2, tx_data.new_note2);
        EXPECT_EQ(inner_data.nullifier1, tx_data.nullifier1);
        EXPECT_EQ(inner_data.nullifier2, tx_data.nullifier2);
        EXPECT_EQ(inner_data.input_owner, tx_data.input_owner);
        EXPECT_EQ(inner_data.output_owner, tx_data.output_owner);
    }
}

HEAVY_TEST_F(rollup_tests_full, test_1_proof_in_3_of_4_rollup_full_proof)
{
    size_t rollup_size = 3;

    append_account_notes();
    append_notes({ 100, 50 });
    world_state.update_root_tree_with_data_root();
    auto join_split_proof = create_join_split_proof({ 2, 3 }, { 100, 50 }, { 70, 80 });
    auto rollup = create_rollup(world_state, rollup_size, { join_split_proof });

    auto rollup_circuit_data =
        rollup::get_circuit_data(rollup_size, join_split_cd, account_cd, claim_cd, srs, "", true, false, false);
    auto result = verify(rollup, rollup_circuit_data);

    ASSERT_TRUE(result.verified);

    auto rollup_data = rollup_proof_data(result.proof_data);
    EXPECT_EQ(rollup_data.rollup_id, 0UL);
    EXPECT_EQ(rollup_data.rollup_size, 4UL);
    EXPECT_EQ(rollup_data.data_start_index, 8UL);
    EXPECT_EQ(rollup_data.old_data_root, rollup.old_data_root);
    EXPECT_EQ(rollup_data.new_data_root, rollup.new_data_root);
    EXPECT_EQ(rollup_data.old_null_root, rollup.old_null_root);
    EXPECT_EQ(rollup_data.new_null_root, rollup.new_null_roots.back());
    EXPECT_EQ(rollup_data.old_data_roots_root, rollup.data_roots_root);
    EXPECT_EQ(rollup_data.new_data_roots_root, rollup.data_roots_root);
    for (size_t i = 0; i < rollup_data.total_tx_fees.size(); ++i) {
        EXPECT_EQ(rollup_data.total_tx_fees[i], i == asset_id ? tx_fee : 0UL);
    }
    EXPECT_EQ(rollup_data.inner_proofs.size(), 4UL);

    auto tx_data = inner_proof_data(join_split_proof);

    {
        auto inner_data = rollup_data.inner_proofs[0];
        EXPECT_EQ(inner_data.public_input, tx_data.public_input);
        EXPECT_EQ(inner_data.public_output, tx_data.public_output);
        EXPECT_EQ(inner_data.new_note1, tx_data.new_note1);
        EXPECT_EQ(inner_data.new_note2, tx_data.new_note2);
        EXPECT_EQ(inner_data.nullifier1, tx_data.nullifier1);
        EXPECT_EQ(inner_data.nullifier2, tx_data.nullifier2);
        EXPECT_EQ(inner_data.input_owner, tx_data.input_owner);
        EXPECT_EQ(inner_data.output_owner, tx_data.output_owner);
    }

    for (size_t i = 1; i < rollup_data.inner_proofs.size(); ++i) {
        auto inner_data = rollup_data.inner_proofs[i];
        EXPECT_EQ(inner_data.public_input, uint256_t(0));
        EXPECT_EQ(inner_data.public_output, uint256_t(0));
        EXPECT_EQ(inner_data.new_note1, grumpkin::g1::affine_element(0));
        EXPECT_EQ(inner_data.new_note2, grumpkin::g1::affine_element(0));
        EXPECT_EQ(inner_data.nullifier1, uint256_t(0));
        EXPECT_EQ(inner_data.nullifier2, uint256_t(0));
        EXPECT_EQ(inner_data.input_owner, fr(0));
        EXPECT_EQ(inner_data.output_owner, fr(0));
    }
}

} // namespace rollup
} // namespace proofs
} // namespace rollup