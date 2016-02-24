#define __LIBELF_INTERNAL__ 1
#include "libelf.h"
#include "gelf.h"

#ifdef EMSCRIPTEN
#include <emscripten/val.h>
#include <emscripten/bind.h>
#endif

#include <vector>
#include <string>
#include <memory>
#include <fstream>
#include <iostream>

#include <cstdio>
#include <cstring>

struct RodataChunk {
#ifdef EMSCRIPTEN
  RodataChunk(): data(emscripten::val::null()) {}
#endif

  size_t offset;
#ifdef EMSCRIPTEN
  emscripten::val data;
#else
  std::vector<unsigned char> data;
#endif
};

struct SymbolInfo {
  size_t address;
  size_t size;
  std::string name;
};

struct ProgramInfo {
  std::string error;
  int addressSize;
  size_t rodataStart;
  std::vector<RodataChunk> rodataChunks;
  std::vector<SymbolInfo> symbols;
};

ProgramInfo process(std::string image) {
  ProgramInfo programInfo = {};

  if (elf_version(EV_CURRENT) == EV_NONE) {
    programInfo.error = "Failed to init libelf.";
    return programInfo;
  }

  Elf *elf = elf_memory(&image[0], image.size());
  if (!elf) {
    programInfo.error = "elf_begin failed. (" + std::string(elf_errmsg(-1)) + ")";
    return programInfo;
  }

  Elf_Kind elfKind = elf_kind(elf);
  if (elfKind != ELF_K_ELF) {
    programInfo.error = "Input is not an ELF object. (" + std::to_string(elfKind) + ")";
    return programInfo;
  }

  GElf_Ehdr elfHeader;
  if (gelf_getehdr(elf, &elfHeader) != &elfHeader) {
    programInfo.error = "Failed to get ELF header. (" + std::string(elf_errmsg(-1)) + ")";
    return programInfo;
  }

  switch (elfHeader.e_machine) {
    case EM_386:
      programInfo.addressSize = 4;
      break;
    case EM_X86_64:
      programInfo.addressSize = 8;
      break;
    default:
    programInfo.error = "Unsupported architecture. (" + std::to_string(elfHeader.e_machine) + ")";
    return programInfo;
  }

  size_t numberOfSections;
  if (elf_getshdrnum(elf, &numberOfSections) != 0) {
    programInfo.error = "Failed to get number of ELF sections. (" + std::string(elf_errmsg(-1)) + ")";
    return programInfo;
  }

  size_t sectionNameStringTableIndex;
  if (elf_getshdrstrndx(elf, &sectionNameStringTableIndex) != 0) {
    programInfo.error = "Failed to get ELF section names. (" + std::string(elf_errmsg(-1)) + ")";
    return programInfo;
  }

  Elf64_Addr dataOffset;
  Elf_Scn *dataScn = nullptr;
  Elf_Scn *symbolTableScn = nullptr;
  Elf_Scn *stringTableScn = nullptr;

  for (size_t elfSectionIndex = 0; elfSectionIndex < numberOfSections; ++elfSectionIndex) {
    Elf_Scn *elfScn = elf_getscn(elf, elfSectionIndex);
    if (!elfScn) {
      programInfo.error = "Failed to get section " + std::to_string(elfSectionIndex) + ". (" + std::string(elf_errmsg(-1)) + ")";
      continue;
    }

    GElf_Shdr elfSectionHeader;
    if (gelf_getshdr(elfScn, &elfSectionHeader) != &elfSectionHeader) {
      programInfo.error = "Failed to get header for section " + std::to_string(elfSectionIndex) + ". (" + std::string(elf_errmsg(-1)) + ")";
      continue;
    }

    const char *name = elf_strptr(elf, sectionNameStringTableIndex, elfSectionHeader.sh_name);
    if (!name) {
      programInfo.error = "Failed to get name of section " + std::to_string(elfSectionIndex) + ". (" + std::string(elf_errmsg(-1)) + ")";
      continue;
    }

    if (elfSectionHeader.sh_type == SHT_SYMTAB && strcmp(name, ".symtab") == 0) {
      symbolTableScn = elfScn;
    } else if (elfSectionHeader.sh_type == SHT_STRTAB && strcmp(name, ".strtab") == 0) {
      stringTableScn = elfScn;
    } else if (elfSectionHeader.sh_type == SHT_PROGBITS && strcmp(name, ".rodata") == 0) {
      dataOffset = elfSectionHeader.sh_addr;
      dataScn = elfScn;
    }

    if (dataScn && symbolTableScn && stringTableScn) {
      break;
    }
  }

  if (!dataScn || !symbolTableScn || !stringTableScn) {
    programInfo.error = "Failed to find all required ELF sections.";
    return programInfo;
  }

  size_t symbolNameStringTableIndex = elf_ndxscn(stringTableScn);
  if (symbolNameStringTableIndex == SHN_UNDEF) {
    programInfo.error = "elf_ndxscn failed. (" + std::string(elf_errmsg(-1)) + ")";
    return programInfo;
  }

  programInfo.rodataStart = dataOffset;

  Elf_Data *data = nullptr;
  while ((data = elf_getdata(dataScn, data)) != nullptr) {
    RodataChunk rodataChunk;
    rodataChunk.offset = data->d_off;
#ifdef EMSCRIPTEN
    // memory_view doesn't do a copy, but we want JS to manage this once embind is done.
    rodataChunk.data = emscripten::val(emscripten::memory_view<unsigned char>(data->d_size, (unsigned char *)data->d_buf)).call<emscripten::val>("slice");
#else
    rodataChunk.data = std::move(std::vector<unsigned char>((char *)data->d_buf, (char *)data->d_buf + data->d_size));
#endif
    programInfo.rodataChunks.push_back(std::move(rodataChunk));
  }

  Elf_Data *symbolData = nullptr;
  while ((symbolData = elf_getdata(symbolTableScn, symbolData)) != nullptr) {
    size_t symbolIndex = 0;
    GElf_Sym symbol;
    while (gelf_getsym(symbolData, symbolIndex++, &symbol) == &symbol) {
      const char *name = elf_strptr(elf, symbolNameStringTableIndex, symbol.st_name);
      if (!name) {
        std::cerr << "Failed to symbol name for " + std::to_string(symbolIndex) + ". (" + std::string(elf_errmsg(-1)) + ")" << std::endl;
        continue;
      }

      SymbolInfo symbolInfo;
      symbolInfo.address = symbol.st_value;
      symbolInfo.size = symbol.st_size;
      symbolInfo.name = name;
      programInfo.symbols.push_back(std::move(symbolInfo));
    }
  }

  elf_end(elf);
  return programInfo;
}

#ifdef EMSCRIPTEN
EMSCRIPTEN_BINDINGS(vtable) {
  emscripten::value_object<ProgramInfo>("ProgramInfo")
    .field("error", &ProgramInfo::error)
    .field("addressSize", &ProgramInfo::addressSize)
    .field("rodataStart", &ProgramInfo::rodataStart)
    .field("rodataChunks", &ProgramInfo::rodataChunks)
    .field("symbols", &ProgramInfo::symbols);

  emscripten::value_object<RodataChunk>("RodataChunk")
    .field("offset", &RodataChunk::offset)
    .field("data", &RodataChunk::data);

  emscripten::value_object<SymbolInfo>("SymbolInfo")
    .field("address", &SymbolInfo::address)
    .field("size", &SymbolInfo::size)
    .field("name", &SymbolInfo::name);

  emscripten::register_vector<RodataChunk>("VectorRodataChunk");
  emscripten::register_vector<SymbolInfo>("VectorSymbolInfo");

  emscripten::function("process", &process);
}
#else
int main(int argc, char *argv[]) {
  if (argc < 2) {
    fprintf(stderr, "Usage: %s <file-name>\n", argv[0]);
    return 1;
  }

  std::ifstream file(argv[1], std::ios::binary);
  std::string image((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());

  ProgramInfo programInfo = process(image);

  if (!programInfo.error.empty()) {
    fprintf(stderr, "Failed to process input file '%s': %s.\n", argv[1], programInfo.error.c_str());
    return 1;
  }

  fprintf(stdout, "address size: %d\n", programInfo.addressSize);
  fprintf(stdout, "rodata start: %08lx\n", programInfo.rodataStart);
  fprintf(stdout, "rodata chunks: %lu\n", programInfo.rodataChunks.size());
  for (const auto &chunk : programInfo.rodataChunks) {
    fprintf(stdout, "  offset: %08lx\n", chunk.offset);
    fprintf(stdout, "    size: %lu\n", chunk.data.size());
  }

  fprintf(stdout, "symbols: %lu\n", programInfo.symbols.size());
  for (const auto &symbol : programInfo.symbols) {
    if (symbol.address == 0 || symbol.size == 0 || symbol.name.empty()) {
      continue;
    }
    fprintf(stdout, "  offset: %08lx\n", symbol.address);
    fprintf(stdout, "    size: %lu\n", symbol.size);
    fprintf(stdout, "    name: %s\n", symbol.name.c_str());
  }

  return 0;
}
#endif
