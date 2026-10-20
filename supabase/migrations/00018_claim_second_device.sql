-- ---------------------------------------------------------------------------
-- claim_anon_identity failed for an account's SECOND device (audit A §0.6).
--
-- idx_viewer_identities_one_canonical (00008) allows exactly one
-- self-canonical identity per account:
--   UNIQUE (auth_user_id) WHERE auth_user_id IS NOT NULL AND canonical_anon_id = anon_id
-- but 00010's claim always left the claimed row self-canonical, so the
-- second device to sign in raised 23505 and /api/session/link returned 500.
--
-- Fix, as 00008 intended ("on sign-in this is repointed at the account's
-- canonical anon_id; that is the entire merge mechanism"): a newly claimed
-- identity points at the account's existing canonical identity if there is
-- one, and becomes canonical itself only for the account's first device.
--
-- The refusal rule from 00010 is unchanged: an identity already owned by a
-- DIFFERENT account is never touched.
--
-- Concurrency: two devices of one account signing in at the same instant
-- would both see "no canonical yet" and both try to become it. A per-user
-- transaction advisory lock serialises claims for the same account; claims
-- for different accounts never contend.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_anon_identity(
  p_anon_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner     uuid;
  v_found     boolean;
  v_canonical uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('claim:' || p_user_id::text, 0));

  SELECT auth_user_id INTO v_owner
  FROM public.viewer_identities
  WHERE anon_id = p_anon_id
  FOR UPDATE;
  v_found := FOUND;

  -- Already claimed. Same user: idempotent success. Different user: refuse,
  -- rather than transplanting one person's history onto another's account.
  IF v_found AND v_owner IS NOT NULL THEN
    RETURN v_owner = p_user_id;
  END IF;

  SELECT anon_id INTO v_canonical
  FROM public.viewer_identities
  WHERE auth_user_id = p_user_id
    AND canonical_anon_id = anon_id
    AND anon_id <> p_anon_id
  LIMIT 1;

  IF NOT v_found THEN
    INSERT INTO public.viewer_identities (anon_id, canonical_anon_id, auth_user_id, linked_at)
    VALUES (p_anon_id, COALESCE(v_canonical, p_anon_id), p_user_id, now());
  ELSE
    UPDATE public.viewer_identities
       SET auth_user_id = p_user_id,
           canonical_anon_id = COALESCE(v_canonical, p_anon_id),
           linked_at = now()
     WHERE anon_id = p_anon_id;
  END IF;
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_anon_identity(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_anon_identity(uuid, uuid) TO service_role;
