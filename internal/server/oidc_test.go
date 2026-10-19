package server

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	jose "github.com/go-jose/go-jose/v4"
	"golang.org/x/oauth2"
)

// Exercise signed tokens and JWKS verification without Google credentials.
func TestVerifiedOIDCCallback(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.EdDSA, Key: private}, (&jose.SignerOptions{}).WithHeader("kid", "fixture"))
	if err != nil {
		t.Fatal(err)
	}
	var issuer, signed string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			json.NewEncoder(w).Encode(map[string]any{"issuer": issuer, "authorization_endpoint": issuer + "/authorize", "token_endpoint": issuer + "/token", "jwks_uri": issuer + "/keys", "id_token_signing_alg_values_supported": []string{"EdDSA"}})
		case "/keys":
			json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: public, KeyID: "fixture", Algorithm: "EdDSA", Use: "sig"}}})
		case "/token":
			json.NewEncoder(w).Encode(map[string]any{"access_token": "fixture-only", "token_type": "Bearer", "id_token": signed})
		default:
			w.WriteHeader(404)
		}
	}))
	defer provider.Close()
	issuer = provider.URL
	p, err := oidc.NewProvider(context.Background(), issuer)
	if err != nil {
		t.Fatal(err)
	}
	for _, variant := range []string{"valid", "nonce", "audience", "expired", "unverified", "domain"} {
		t.Run(variant, func(t *testing.T) {
			s := testServer(t)
			s.Core.Config.GoogleID = "fixture-client"
			s.auth.provider = p
			s.auth.oauth.ClientID = "fixture-client"
			s.auth.oauth.Endpoint = oauth2.Endpoint{AuthURL: issuer + "/authorize", TokenURL: issuer + "/token", AuthStyle: oauth2.AuthStyleInParams}
			start := request(s, "GET", "/api/auth/sign-in/google", "", "", nil, false)
			location, _ := url.Parse(start.Header().Get("Location"))
			nonce := location.Query().Get("nonce")
			claims := map[string]any{"iss": issuer, "sub": "fixture-user", "aud": "fixture-client", "exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(), "nonce": nonce, "email": "student@ubu.ac.th", "email_verified": true, "hd": "ubu.ac.th", "name": "Student"}
			switch variant {
			case "nonce":
				claims["nonce"] = "wrong"
			case "audience":
				claims["aud"] = "other-client"
			case "expired":
				claims["exp"] = time.Now().Add(-time.Hour).Unix()
			case "unverified":
				claims["email_verified"] = false
			case "domain":
				claims["hd"] = "other.edu"
			}
			payload, _ := json.Marshal(claims)
			object, _ := signer.Sign(payload)
			signed, _ = object.CompactSerialize()
			r := httptest.NewRequest("GET", "/api/auth/callback/google?code=fixture&state="+url.QueryEscape(location.Query().Get("state")), nil)
			for _, cookie := range start.Result().Cookies() {
				r.AddCookie(cookie)
			}
			w := httptest.NewRecorder()
			s.Handler().ServeHTTP(w, r)
			if variant != "valid" {
				if w.Code != 403 {
					t.Fatalf("unverified identity accepted: %d", w.Code)
				}
				return
			}
			if w.Code != 302 {
				t.Fatalf("valid callback failed: %d %s", w.Code, w.Body.String())
			}
			found := false
			for _, cookie := range w.Result().Cookies() {
				if cookie.Name == "labgate_session" && cookie.Value != "" {
					found = true
					if !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode {
						t.Fatal("unsafe session cookie")
					}
				}
			}
			if !found {
				t.Fatal("session missing")
			}
		})
	}
}
