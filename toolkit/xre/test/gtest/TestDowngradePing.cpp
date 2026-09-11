/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

#include "gtest/gtest.h"
#include "json/json.h"
#include "mozilla/Preferences.h"
#include "mozilla/XREAppData.h"
#include "nsAppRunner.h"
#include "nsDirectoryServiceDefs.h"
#include "nsIFile.h"
#include "nsIProperties.h"
#include "nsIPropertyBag2.h"
#include "nsString.h"
#include "prtime.h"

#include <cstdio>

using mozilla::Preferences;
using mozilla::PrefValueKind;

class DowngradePingTest : public ::testing::Test {
 protected:
  const mozilla::XREAppData* mOriginalAppData = nullptr;
  mozilla::XREAppData mFakeAppData{};
  mozilla::PathString mCreatedPingPath;
  nsCOMPtr<nsIFile> mTmpAppDataDir;

  void SetUp() override {
    mFakeAppData.name = "TestApp";
    mFakeAppData.version = "130.0";
    mFakeAppData.buildID = "20250101000000";
    mFakeAppData.vendor = "TestVendor";
    mOriginalAppData = gAppData;
    gAppData = &mFakeAppData;

    nsCOMPtr<nsIFile> tmpDir;
    ASSERT_EQ(NS_OK,
              NS_GetSpecialDirectory(NS_OS_TEMP_DIR, getter_AddRefs(tmpDir)));
    ASSERT_EQ(NS_OK, tmpDir->Append(u"downgrade-ping-test"_ns));
    ASSERT_EQ(NS_OK, tmpDir->CreateUnique(nsIFile::DIRECTORY_TYPE, 0755));
    mTmpAppDataDir = tmpDir;

    nsCOMPtr<nsIProperties> dirSvc =
        do_GetService(NS_DIRECTORY_SERVICE_CONTRACTID);
    ASSERT_TRUE(dirSvc);
    ASSERT_EQ(NS_OK, dirSvc->Set(XRE_USER_APP_DATA_DIR, mTmpAppDataDir));

    ASSERT_EQ(NS_OK,
              Preferences::SetBool("datareporting.healthreport.uploadEnabled",
                                   true, PrefValueKind::User));
    ASSERT_EQ(NS_OK,
              Preferences::SetCString("toolkit.telemetry.server",
                                      "https://incoming.telemetry.test"_ns,
                                      PrefValueKind::User));
    ASSERT_EQ(NS_OK, Preferences::SetCString("toolkit.telemetry.cachedClientID",
                                             "test-client-id-1234"_ns,
                                             PrefValueKind::User));
    ASSERT_EQ(NS_OK, Preferences::SetCString(
                         "toolkit.telemetry.cachedProfileGroupID",
                         "test-profile-group-id-5678"_ns, PrefValueKind::User));
  }

  void TearDown() override {
    if (mOriginalAppData) {
      gAppData = mOriginalAppData;
      mOriginalAppData = nullptr;
    }
    Preferences::ClearUser("datareporting.healthreport.uploadEnabled");
    Preferences::ClearUser("toolkit.telemetry.server");
    Preferences::ClearUser("toolkit.telemetry.cachedClientID");
    Preferences::ClearUser("toolkit.telemetry.cachedProfileGroupID");
    if (mTmpAppDataDir) {
      nsCOMPtr<nsIProperties> dirSvc =
          do_GetService(NS_DIRECTORY_SERVICE_CONTRACTID);
      if (dirSvc) {
        dirSvc->Undefine(XRE_USER_APP_DATA_DIR);
      }
      mTmpAppDataDir->Remove(true);
      mTmpAppDataDir = nullptr;
    }
  }

  bool ReadPingFile(const mozilla::PathString& aPath, nsCString& aOutContents) {
    nsCOMPtr<nsIFile> file;
    nsresult rv = NS_NewPathStringLocalFile(aPath, getter_AddRefs(file));
    if (NS_FAILED(rv) || !file) return false;

    int64_t fileSize;
    rv = file->GetFileSize(&fileSize);
    if (NS_FAILED(rv)) return false;

    FILE* f = nullptr;
    rv = file->OpenANSIFileDesc("rb", &f);
    if (NS_FAILED(rv) || !f) return false;

    aOutContents.SetLength(fileSize);
    size_t bytesRead = fread(aOutContents.BeginWriting(), 1, fileSize, f);
    fclose(f);
    return bytesRead == static_cast<size_t>(fileSize);
  }
};

TEST_F(DowngradePingTest, MissingClientId) {
  Preferences::ClearUser("toolkit.telemetry.cachedClientID");

  EXPECT_FALSE(GenerateDowngradeTelemetry(
      "test-ping-id"_ns, "131.0_20250201000000/20250201000000"_ns, false, 0,
      "test-channel"_ns));
}

TEST_F(DowngradePingTest, InvalidVersionFormat) {
  EXPECT_FALSE(GenerateDowngradeTelemetry("test-ping-id"_ns,
                                          "131.0-no-underscore"_ns, false, 0,
                                          "test-channel"_ns));
}

TEST_F(DowngradePingTest, FullPingStructure) {
  auto result = GenerateDowngradeTelemetry(
      "test-ping-id"_ns, "131.0_20250201000000/20250201000000"_ns, true, 1,
      "test-channel"_ns);
  ASSERT_TRUE(result);
  mCreatedPingPath = *result;

  nsCString url;
  ASSERT_TRUE(BuildDowngradePingUrl("test-ping-id"_ns, "test-channel"_ns, url));
  EXPECT_TRUE(StringBeginsWith(url, "https://incoming.telemetry.test"_ns));
  EXPECT_NE(url.Find("/downgrade/"), kNotFound);

  nsCString contents;
  ASSERT_TRUE(ReadPingFile(*result, contents));

  Json::Value root;
  Json::Reader reader;
  ASSERT_TRUE(
      reader.parse(contents.BeginReading(), contents.EndReading(), root));

  EXPECT_STREQ(root["type"].asCString(), "downgrade");
  EXPECT_STREQ(root["id"].asCString(), "test-ping-id");
  {
    std::string dateStr = root["creationDate"].asString();
    EXPECT_FALSE(dateStr.empty());
    int year, month, day, hour, minute, second;
    EXPECT_EQ(6, sscanf(dateStr.c_str(), "%d-%d-%dT%d:%d:%d", &year, &month,
                        &day, &hour, &minute, &second));
    PRExplodedTime pingExploded = {};
    pingExploded.tm_year = year;
    pingExploded.tm_month = month - 1;
    pingExploded.tm_mday = day;
    pingExploded.tm_hour = hour;
    pingExploded.tm_min = minute;
    pingExploded.tm_sec = second;
    pingExploded.tm_params = PR_GMTParameters(&pingExploded);
    PRTime pingTime = PR_ImplodeTime(&pingExploded);
    double diff = double(PR_Now() - pingTime) / PR_USEC_PER_SEC;
    EXPECT_GE(diff, 0);
    EXPECT_LT(diff, 600);
  }
  EXPECT_EQ(root["version"].asInt(), 4);
  EXPECT_STREQ(root["clientId"].asCString(), "test-client-id-1234");
  EXPECT_STREQ(root["profileGroupId"].asCString(),
               "test-profile-group-id-5678");

  Json::Value app = root["application"];
  EXPECT_TRUE(app.isObject());
  {
    nsCOMPtr<nsIPropertyBag2> sysInfo =
        do_GetService("@mozilla.org/system-info;1");
    ASSERT_TRUE(sysInfo);
    nsAutoCString expectedArch;
    sysInfo->GetPropertyAsACString(u"arch"_ns, expectedArch);
    EXPECT_STREQ(app["architecture"].asCString(), expectedArch.get());
  }
  EXPECT_STREQ(app["buildId"].asCString(), "20250101000000");
  EXPECT_STREQ(app["name"].asCString(), "TestApp");
  EXPECT_STREQ(app["version"].asCString(), "130.0");
  EXPECT_STREQ(app["vendor"].asCString(), "TestVendor");
  EXPECT_STREQ(app["channel"].asCString(), "test-channel");

  Json::Value payload = root["payload"];
  EXPECT_TRUE(payload.isObject());
  EXPECT_STREQ(payload["lastVersion"].asCString(), "131.0");
  EXPECT_STREQ(payload["lastBuildId"].asCString(), "20250201000000");
  EXPECT_TRUE(payload["hasSync"].asBool());
  EXPECT_EQ(payload["button"].asInt(), 1);
}

TEST_F(DowngradePingTest, PayloadBooleansFalse) {
  auto result = GenerateDowngradeTelemetry(
      "test-ping-id"_ns, "131.0_20250201000000/20250201000000"_ns, false, 0,
      "test-channel"_ns);
  ASSERT_TRUE(result);
  mCreatedPingPath = *result;

  nsCString contents;
  ASSERT_TRUE(ReadPingFile(*result, contents));

  Json::Value root;
  Json::Reader reader;
  ASSERT_TRUE(
      reader.parse(contents.BeginReading(), contents.EndReading(), root));

  Json::Value payload = root["payload"];
  EXPECT_FALSE(payload["hasSync"].asBool());
  EXPECT_EQ(payload["button"].asInt(), 0);
}
